// WITH_GENESYS
import { ProfilerService } from 'three';

function createCommonRenderer() {

	const listeners = new Set();
	const pending = new Map();
	const resolved = new Map();
	const resolvedRanges = new Map();
	let gpuTime = 0n;

	const backend = {
		hasTimestamp: true,
		trackTimestamp: false,
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

			const start = gpuStartMs === null ? gpuTime : BigInt( gpuStartMs * 1e6 );
			const end = start + BigInt( duration * 1e6 );
			gpuTime = end;
			pending.set( uid, {
				type,
				duration,
				range: options?.omitRange === true ? null : { start, end },
			} );
			for ( const listener of listeners ) listener( type, uid, label );

		},
		resolve( type ) {

			for ( const [ uid, entry ] of pending ) {

				if ( entry.type === type ) {

					resolved.set( uid, entry.duration );
					if ( entry.range !== null ) resolvedRanges.set( uid, entry.range );
					pending.delete( uid );

				}

			}

		},
	};

	return {
		isRenderer: true,
		backend,
		async init() {},
		hasFeature( name ) {

			return name === 'timestamp-query';

		},
		async resolveTimestampsAsync( type ) {

			backend.resolve( type );

		},
	};

}

function createLegacyWebGLRenderer( { disjoint = false } = {} ) {

	const extension = {
		TIME_ELAPSED_EXT: 0x88BF,
		GPU_DISJOINT_EXT: 0x8FBB,
	};
	const gl = {
		QUERY_RESULT_AVAILABLE: 0x8867,
		QUERY_RESULT: 0x8866,
		activeQuery: null,
		deletedQueries: new Set(),
		getExtension( name ) {

			return name === 'EXT_disjoint_timer_query_webgl2' ? extension : null;

		},
		createQuery() {

			return { available: false, result: 4e6 };

		},
		beginQuery( target, query ) {

			this.activeQuery = query;

		},
		endQuery() {

			this.activeQuery.available = true;
			this.activeQuery = null;

		},
		getQueryParameter( query, parameter ) {

			return parameter === this.QUERY_RESULT_AVAILABLE ? query.available : query.result;

		},
		getParameter( parameter ) {

			return parameter === extension.GPU_DISJOINT_EXT && disjoint;

		},
		deleteQuery( query ) {

			this.deletedQueries.add( query );

		},
		isContextLost() {

			return false;

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

export default QUnit.module( 'Profiler', hooks => {

	hooks.beforeEach( () => {

		ProfilerService.setProfile( 'full' );
		ProfilerService.enable();

	} );

	hooks.afterEach( () => {

		ProfilerService.disable();

	} );

	QUnit.test( 'collects labelled common-renderer GPU spans', async assert => {

		const renderer = createCommonRenderer();
		assert.true( await ProfilerService.attachGpuRenderer( renderer ), 'renderer supports timestamps' );

		const span = ProfilerService.beginGpu( 'gpu-pass', renderer );
		renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
		renderer.backend.emit( 'compute', 'c:0:2:f1', 3 );
		ProfilerService.endGpu( span );
		await ProfilerService.flushGpu( renderer );

		const stats = ProfilerService.getGpuStats( 'gpu-pass' );
		assert.strictEqual( stats.samples, 1, 'one sample committed' );
		assert.strictEqual( stats.avg, 5, 'render and compute durations are summed' );
		const unlabeled = ProfilerService.getGpuStats( 'GPU pass: (unlabeled)' );
		assert.ok( unlabeled, 'unlabeled queries are also surfaced' );
		assert.strictEqual( unlabeled.samples, 2, 'render + compute unlabeled slices' );
		assert.deepEqual(
			ProfilerService.exportGpuJSON().map( entry => entry.label ).sort(),
			[ 'GPU pass: (unlabeled)', 'gpu-pass' ],
			'GPU JSON export is separate'
		);

	} );

	QUnit.test( 'collects labelled common-renderer GPU passes', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		renderer.backend.emit( 'render', 'r:0:1:f1', 2, 'Bloom [ High Pass ]' );
		await ProfilerService.flushGpu( renderer );

		const stats = ProfilerService.getGpuStats( 'GPU pass: Bloom [ High Pass ]' );
		assert.strictEqual( stats.samples, 1, 'one pass sample committed' );
		assert.strictEqual( stats.avg, 2, 'pass duration is preserved' );

	} );

	QUnit.test( 'uses raw GPU start and end timestamps in traces', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const parent = ProfilerService.beginGpu( 'gpu-frame', renderer );
		renderer.backend.emit( 'render', 'r:0:1:f1', 2, 'First', 10 );
		renderer.backend.emit( 'render', 'r:1:2:f1', 1, 'Second', 15 );
		ProfilerService.endGpu( parent );
		await ProfilerService.flushGpu( renderer );

		const trace = ProfilerService.exportChromeTrace();
		const first = trace.traceEvents.find( event => event.name === 'GPU pass: First' );
		const second = trace.traceEvents.find( event => event.name === 'GPU pass: Second' );

		assert.strictEqual( first.dur, 2000, 'first pass uses its GPU duration' );
		assert.strictEqual( second.ts - first.ts, 5000, 'pass starts preserve the GPU timestamp gap' );
		assert.strictEqual( ProfilerService.getGpuStats( 'gpu-frame' ).avg, 6, 'parent uses the GPU start/end envelope' );

	} );

	QUnit.test( 'nests labelled GPU passes inside parent beginGpu envelope', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const parent = ProfilerService.beginGpu( 'renderPipeline', renderer );
		renderer.backend.emit( 'render', 'r:0:1:f1', 2, null, 10 );
		renderer.backend.emit( 'render', 'r:1:2:f1', 4, 'AO', 14 );
		renderer.backend.emit( 'render', 'r:2:3:f1', 1, 'Bloom', 20 );
		ProfilerService.endGpu( parent );
		await ProfilerService.flushGpu( renderer );

		const trace = ProfilerService.exportChromeTrace();
		const parentEvent = trace.traceEvents.find( event => event.name === 'renderPipeline' && event.ph === 'X' );
		const ao = trace.traceEvents.find( event => event.name === 'GPU pass: AO' );
		const bloom = trace.traceEvents.find( event => event.name === 'GPU pass: Bloom' );

		assert.ok( parentEvent, 'parent trace event exists' );
		assert.ok( ao, 'AO pass trace event exists' );
		assert.ok( bloom, 'Bloom pass trace event exists' );
		assert.ok( ao.ts >= parentEvent.ts, 'AO starts at or after parent' );
		assert.ok( ao.ts + ao.dur <= parentEvent.ts + parentEvent.dur, 'AO ends within parent' );
		assert.ok( bloom.ts >= parentEvent.ts, 'Bloom starts at or after parent' );
		assert.ok( bloom.ts + bloom.dur <= parentEvent.ts + parentEvent.dur, 'Bloom ends within parent' );

	} );

	QUnit.test( 'snaps overlapping labelled GPU passes to half-open intervals', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const parent = ProfilerService.beginGpu( 'renderPipeline', renderer );
		// Same GPU start → would force a second Speedscope lane without snapping.
		renderer.backend.emit( 'render', 'r:0:1:f1', 0.001, 'DoF [ CoC Blur ]', 10 );
		renderer.backend.emit( 'render', 'r:1:2:f1', 0.066, 'RTT', 10 );
		// 1µs overlap after µs rounding (end 12.001ms vs start 12.000ms).
		renderer.backend.emit( 'render', 'r:2:3:f1', 2.001, 'DoF [ Blur64 Far ]', 14 );
		renderer.backend.emit( 'render', 'r:3:4:f1', 0.066, 'DoF [ Blur16 Far ]', 16 );
		ProfilerService.endGpu( parent );
		await ProfilerService.flushGpu( renderer );

		const trace = ProfilerService.exportChromeTrace();
		const passes = trace.traceEvents
			.filter( event => event.ph === 'X' && event.name.startsWith( 'GPU pass:' ) )
			.sort( ( a, b ) => a.ts - b.ts || b.dur - a.dur );

		assert.strictEqual( passes.length, 4, 'four labelled passes emitted' );

		for ( let i = 1; i < passes.length; i ++ ) {

			assert.ok(
				passes[ i ].ts >= passes[ i - 1 ].ts + passes[ i - 1 ].dur,
				`${ passes[ i ].name } starts at or after previous end (half-open)`
			);

		}

		// Stats keep the raw measured duration for RTT (not the snapped trace placement).
		assert.strictEqual( ProfilerService.getGpuStats( 'GPU pass: RTT' ).avg, 0.066, 'stats keep raw duration' );

	} );

	QUnit.test( 'expands beginGpu parent trace to contain snapped passes', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const parent = ProfilerService.beginGpu( 'renderPipeline', renderer );
		// Parent raw envelope ends before the last snapped child would.
		renderer.backend.emit( 'render', 'r:0:1:f1', 1, 'AO', 10 );
		renderer.backend.emit( 'render', 'r:1:2:f1', 1, 'Scene', 11.5 );
		ProfilerService.endGpu( parent );
		await ProfilerService.flushGpu( renderer );

		const trace = ProfilerService.exportChromeTrace();
		const parentEvent = trace.traceEvents.find( event => event.name === 'renderPipeline' && event.ph === 'X' );
		const passes = trace.traceEvents
			.filter( event => event.ph === 'X' && event.name.startsWith( 'GPU pass:' ) )
			.sort( ( a, b ) => a.ts - b.ts );

		assert.ok( parentEvent, 'parent event exists' );
		assert.ok( passes.length >= 2, 'pass events exist' );
		assert.ok( parentEvent.ts <= passes[ 0 ].ts, 'parent starts at or before first pass' );
		const last = passes[ passes.length - 1 ];
		assert.ok(
			parentEvent.ts + parentEvent.dur >= last.ts + last.dur,
			'parent ends at or after last pass (Speedscope nesting)'
		);

	} );

	QUnit.test( 'surfaces unlabeled timestamp queries as GPU passes', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const parent = ProfilerService.beginGpu( 'renderPipeline', renderer );
		renderer.backend.emit( 'render', 'r:0:1:f1', 1, 'AO', 10 );
		renderer.backend.emit( 'render', 'r:1:2:f1', 2, null, 12 );
		ProfilerService.endGpu( parent );
		await ProfilerService.flushGpu( renderer );

		const trace = ProfilerService.exportChromeTrace();
		const unlabeled = trace.traceEvents.find( event => event.name === 'GPU pass: (unlabeled)' );
		assert.ok( unlabeled, 'unlabeled query becomes a pass slice' );
		assert.strictEqual( unlabeled.dur, 2000, 'unlabeled duration preserved' );

	} );

	QUnit.test( 'parent envelope uses partial timestamp ranges', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const parent = ProfilerService.beginGpu( 'renderPipeline', renderer );
		renderer.backend.emit( 'render', 'r:0:1:f1', 2, null, 10 );
		renderer.backend.emit( 'render', 'r:1:2:f1', 3, 'AO', 14 );
		renderer.backend.emit( 'render', 'r:2:3:f1', 1, null, 18, { omitRange: true } );
		ProfilerService.endGpu( parent );
		await ProfilerService.flushGpu( renderer );

		const trace = ProfilerService.exportChromeTrace();
		const parentEvent = trace.traceEvents.find( event => event.name === 'renderPipeline' && event.ph === 'X' );
		const ao = trace.traceEvents.find( event => event.name === 'GPU pass: AO' );

		assert.ok( parentEvent, 'parent trace event exists' );
		assert.ok( ao, 'AO pass trace event exists' );
		assert.ok( parentEvent.dur >= 7000 && parentEvent.dur <= 7001, 'parent uses ranged envelope (10..17ms), not CPU sum fallback' );
		assert.ok( ao.ts >= parentEvent.ts, 'AO starts at or after parent' );
		assert.ok( ao.ts + ao.dur <= parentEvent.ts + parentEvent.dur, 'AO ends within parent' );

	} );

	QUnit.test( 'associates nested common-renderer spans with active queries', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const parent = ProfilerService.beginGpu( 'parent', renderer );
		renderer.backend.emit( 'render', 'r:0:1:f1', 1 );
		const child = ProfilerService.beginGpu( 'child', renderer );
		renderer.backend.emit( 'render', 'r:1:2:f1', 2 );
		ProfilerService.endGpu( child );
		renderer.backend.emit( 'render', 'r:2:3:f1', 3 );
		ProfilerService.endGpu( parent );
		await ProfilerService.flushGpu( renderer );

		assert.strictEqual( ProfilerService.getGpuStats( 'parent' ).avg, 6, 'parent includes all active pass queries' );
		assert.strictEqual( ProfilerService.getGpuStats( 'child' ).avg, 2, 'child includes only its active pass query' );

	} );

	QUnit.test( 'drops stale common-renderer results after reset', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const span = ProfilerService.beginGpu( 'stale', renderer );
		renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
		ProfilerService.endGpu( span );
		ProfilerService.reset();
		await ProfilerService.flushGpu( renderer );

		assert.strictEqual( ProfilerService.getGpuStats( 'stale' ), null, 'stale sample was not committed' );

	} );

	QUnit.test( 'restores common-renderer timestamp tracking on disable', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );
		assert.true( renderer.backend.trackTimestamp, 'tracking enabled while attached' );

		ProfilerService.disable();
		assert.false( renderer.backend.trackTimestamp, 'previous tracking state restored' );

	} );

	QUnit.test( 'collects non-nested legacy WebGL spans', async assert => {

		const renderer = createLegacyWebGLRenderer();
		assert.true( await ProfilerService.attachGpuRenderer( renderer ), 'timer-query extension is available' );

		const span = ProfilerService.beginGpu( 'legacy', renderer );
		const nested = ProfilerService.beginGpu( 'nested', renderer );
		assert.strictEqual( nested._seq, 0, 'nested span is a no-op' );
		ProfilerService.endGpu( span );
		await ProfilerService.flushGpu( renderer );

		assert.strictEqual( ProfilerService.getGpuStats( 'legacy' ).avg, 4, 'elapsed nanoseconds converted to milliseconds' );
		assert.strictEqual( renderer.gl.deletedQueries.size, 1, 'completed query deleted' );

	} );

	QUnit.test( 'rejects disjoint legacy WebGL samples', async assert => {

		const renderer = createLegacyWebGLRenderer( { disjoint: true } );
		await ProfilerService.attachGpuRenderer( renderer );

		const span = ProfilerService.beginGpu( 'disjoint', renderer );
		ProfilerService.endGpu( span );
		await ProfilerService.flushGpu( renderer );

		assert.strictEqual( ProfilerService.getGpuStats( 'disjoint' ), null, 'unreliable result discarded' );

	} );

	QUnit.test( 'uses no-op spans when legacy WebGL timestamps are unavailable', async assert => {

		const renderer = createLegacyWebGLRenderer();
		renderer.gl.getExtension = () => null;

		assert.false( await ProfilerService.attachGpuRenderer( renderer ), 'renderer reports unavailable timestamps' );
		assert.strictEqual( ProfilerService.beginGpu( 'unsupported', renderer )._seq, 0, 'GPU span is a no-op' );
		assert.strictEqual( renderer.gl.deletedQueries.size, 0, 'no query was allocated' );

	} );

	QUnit.test( 'exports GPU trace events on a dedicated lane', async assert => {

		const renderer = createCommonRenderer();
		await ProfilerService.attachGpuRenderer( renderer );

		const span = ProfilerService.beginGpu( 'trace-gpu', renderer );
		renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
		ProfilerService.endGpu( span );
		await ProfilerService.flushGpu( renderer );

		const trace = ProfilerService.exportChromeTrace();
		assert.true( trace.traceEvents.some( event => event.ph === 'X' && event.tid === 3 ), 'GPU slice uses tid=3' );
		assert.true( trace.traceEvents.some( event => event.ph === 'M' && event.tid === 3 ), 'GPU lane metadata included' );

	} );

} );
// !WITH_GENESYS
