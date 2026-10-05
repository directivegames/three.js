// WITH_GENESYS
/**
 * Test doubles for ProfilerService suites: a deterministic `performance.now()`,
 * fake common (WebGPU-style) and legacy WebGL renderers, and trace-shape helpers.
 */

// Captured at import: core/Clock.tests.js replaces the global with a `now()`-only mock and never restores it.
const realPerformance = self.performance;

/**
 * Installs the browser's `performance` object for the duration of a test.
 *
 * @return {function(): void} Restores the previous global.
 */
export function useRealPerformance() {

	const previous = self.performance;
	self.performance = realPerformance;

	return () => {

		self.performance = previous;

	};

}

/**
 * Replaces `performance.now()` with a manually advanced clock.
 *
 * @param {number} [startMs=1000]
 * @return {{ set: function(number): void, advance: function(number): void, restore: function(): void }}
 */
export function installFakeClock( startMs = 1000 ) {

	let now = startMs;
	Object.defineProperty( performance, 'now', {
		configurable: true,
		writable: true,
		value: () => now,
	} );

	return {
		set( ms ) {

			now = ms;

		},
		advance( ms ) {

			now += ms;

		},
		restore() {

			delete performance.now;

		},
	};

}

/**
 * Fake `Renderer` (common renderer) whose backend reports timestamp queries to listeners
 * and resolves them on `resolveTimestampsAsync()`, mirroring `TimestampQueryPool`.
 *
 * Reporting the same uid twice accumulates its duration and widens its range, like a pool
 * that owns several offsets for one render context. Like `WebGPUTimestampQueryPool`, each
 * resolve that runs replaces the earlier timestamps of its type.
 *
 * @param {Object} [options]
 * @param {boolean} [options.timestampFeature=true] Whether `hasFeature( 'timestamp-query' )` is true.
 * @param {number} [options.deferResolves=0] Number of resolve calls that resolve nothing.
 * @param {?function(): Promise<void>} [options.init=null] Custom `init()` implementation.
 * @param {boolean} [options.passTimestamps=false] Whether the backend can time spans inside passes.
 */
export function createCommonRenderer( { timestampFeature = true, deferResolves = 0, init = null, passTimestamps = false } = {} ) {

	const listeners = new Set();
	const pending = new Map();
	const resolved = new Map();
	const resolvedRanges = new Map();
	const resolvedTypes = new Map();
	let gpuTime = 0n;
	let deferredResolvesLeft = deferResolves;

	const backend = {
		hasTimestamp: true,
		trackTimestamp: false,
		supportsPassTimestamps: passTimestamps,
		passTimestampLevel: 0,
		listeners,
		resolveCalls: 0,
		addTimestampQueryListener( listener ) {

			listeners.add( listener );

		},
		removeTimestampQueryListener( listener ) {

			listeners.delete( listener );

		},
		hasTimestampQuery( uid ) {

			return resolved.has( uid );

		},
		getTimestamp( uid ) {

			return resolved.get( uid );

		},
		getTimestampRange( uid ) {

			return resolvedRanges.get( uid ) ?? null;

		},
		emit( type, uid, duration, label = null, gpuStartMs = null, options = null ) {

			const start = gpuStartMs === null ? gpuTime : BigInt( Math.round( gpuStartMs * 1e6 ) );
			const end = start + BigInt( Math.round( duration * 1e6 ) );
			gpuTime = end;
			const range = options?.omitRange === true ? null : { start, end };

			const existing = pending.get( uid );
			if ( existing !== undefined ) {

				existing.duration += duration;
				if ( existing.range !== null && range !== null ) {

					existing.range = {
						start: range.start < existing.range.start ? range.start : existing.range.start,
						end: range.end > existing.range.end ? range.end : existing.range.end,
					};

				}

			} else {

				pending.set( uid, { type, duration, range } );

			}

			for ( const listener of listeners ) listener( type, uid, label, options?.parentUid ?? null );

		},
		resolve( type ) {

			if ( deferredResolvesLeft > 0 ) {

				deferredResolvesLeft --;
				return;

			}

			for ( const [ uid, entryType ] of resolvedTypes ) {

				if ( entryType === type ) {

					resolved.delete( uid );
					resolvedRanges.delete( uid );
					resolvedTypes.delete( uid );

				}

			}

			for ( const [ uid, entry ] of pending ) {

				if ( entry.type === type ) {

					resolved.set( uid, entry.duration );
					resolvedTypes.set( uid, type );
					if ( entry.range !== null ) resolvedRanges.set( uid, entry.range );
					pending.delete( uid );

				}

			}

		},
	};

	return {
		isRenderer: true,
		backend,
		init: init ?? ( async () => {} ),
		hasFeature( name ) {

			return timestampFeature && name === 'timestamp-query';

		},
		async resolveTimestampsAsync( type ) {

			backend.resolveCalls ++;
			backend.resolve( type );

		},
	};

}

/**
 * Fake `WebGLRenderer` exposing `EXT_disjoint_timer_query_webgl2`. Every query reports
 * 4 ms of GPU time once it has ended and has been polled more than `availableAfterPolls` times.
 *
 * @param {Object} [options]
 * @param {boolean} [options.disjoint=false] Constant `GPU_DISJOINT_EXT` value.
 * @param {?boolean[]} [options.disjointSequence=null] Per-read `GPU_DISJOINT_EXT` values (then `false`).
 * @param {number} [options.availableAfterPolls=0] Polls that report the result as unavailable.
 * @param {number} [options.throwOnPoll=0] 1-based availability poll (across all queries) that throws.
 * @param {boolean} [options.beginQueryThrows=false]
 */
export function createLegacyWebGLRenderer( {
	disjoint = false,
	disjointSequence = null,
	availableAfterPolls = 0,
	throwOnPoll = 0,
	beginQueryThrows = false,
} = {} ) {

	const extension = {
		TIME_ELAPSED_EXT: 0x88BF,
		GPU_DISJOINT_EXT: 0x8FBB,
	};
	let pollCount = 0;

	const gl = {
		QUERY_RESULT_AVAILABLE: 0x8867,
		QUERY_RESULT: 0x8866,
		activeQuery: null,
		contextLost: false,
		createdQueries: [],
		deletedQueries: new Set(),
		getExtension( name ) {

			return name === 'EXT_disjoint_timer_query_webgl2' ? extension : null;

		},
		createQuery() {

			const query = { ended: false, polls: 0, result: 4e6 };
			this.createdQueries.push( query );
			return query;

		},
		beginQuery( target, query ) {

			if ( beginQueryThrows ) throw new Error( 'beginQuery failed' );
			this.activeQuery = query;

		},
		endQuery() {

			this.activeQuery.ended = true;
			this.activeQuery = null;

		},
		getQueryParameter( query, parameter ) {

			if ( parameter === this.QUERY_RESULT_AVAILABLE ) {

				pollCount ++;
				if ( pollCount === throwOnPoll ) throw new Error( 'getQueryParameter failed' );
				query.polls ++;
				return query.ended && query.polls > availableAfterPolls;

			}

			return query.result;

		},
		getParameter( parameter ) {

			if ( parameter !== extension.GPU_DISJOINT_EXT ) return null;
			if ( disjointSequence !== null ) return disjointSequence.length > 0 ? disjointSequence.shift() : false;
			return disjoint;

		},
		deleteQuery( query ) {

			this.deletedQueries.add( query );

		},
		isContextLost() {

			return this.contextLost;

		},
	};

	return {
		isWebGLRenderer: true,
		getContext() {

			return gl;

		},
		gl,
	};

}

/**
 * @return {Promise<void>} Resolves after the next animation frame and a macrotask.
 */
export function nextFrame() {

	return new Promise( resolve => requestAnimationFrame( () => setTimeout( resolve, 0 ) ) );

}

/**
 * @param {number} ms
 * @return {Promise<void>}
 */
export function delay( ms ) {

	return new Promise( resolve => setTimeout( resolve, ms ) );

}

/**
 * Pairs of complete (`ph: 'X'`) slices on the same thread that partially overlap,
 * i.e. neither nests inside the other. Trace viewers cannot stack such slices.
 *
 * @param {Array<{ name: string, ph: string, ts: number, dur: number, tid: number }>} events
 * @return {string[]} Human-readable descriptions of each offending pair.
 */
export function findPartialOverlaps( events ) {

	const slices = events.filter( event => event.ph === 'X' );
	const overlaps = [];

	for ( let i = 0; i < slices.length; i ++ ) {

		for ( let j = 0; j < slices.length; j ++ ) {

			const a = slices[ i ];
			const b = slices[ j ];
			if ( i === j || a.tid !== b.tid ) continue;

			const aEnd = a.ts + a.dur;
			const bEnd = b.ts + b.dur;
			if ( a.ts < b.ts && b.ts < aEnd && aEnd < bEnd ) {

				overlaps.push( `${a.name} [${a.ts}, ${aEnd}) overlaps ${b.name} [${b.ts}, ${bEnd}) on tid ${a.tid}` );

			}

		}

	}

	return overlaps;

}

/**
 * @return {number} User Timing marks and measures created by the profiler (`gnsx:` prefix).
 */
export function countGnsxUserTimingEntries() {

	return [ ...performance.getEntriesByType( 'mark' ), ...performance.getEntriesByType( 'measure' ) ]
		.filter( entry => entry.name.startsWith( 'gnsx:' ) )
		.length;

}

/**
 * Temporarily replaces `console[ method ]` with a recorder.
 *
 * @param {'log'|'table'|'warn'} method
 * @return {{ calls: Array<Array<*>>, restore: function(): void }}
 */
export function captureConsole( method ) {

	const original = console[ method ];
	const calls = [];
	console[ method ] = ( ...args ) => calls.push( args );

	return {
		calls,
		restore() {

			console[ method ] = original;

		},
	};

}

/**
 * @param {Object} assert
 * @param {number} actual
 * @param {number} expected
 * @param {string} message
 * @param {number} [epsilon=1e-9]
 */
export function assertClose( assert, actual, expected, message, epsilon = 1e-9 ) {

	assert.pushResult( {
		result: Math.abs( actual - expected ) <= epsilon,
		actual,
		expected,
		message,
	} );

}
// !WITH_GENESYS
