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
		emit( type, uid, duration, label = null, gpuStartMs = null ) {

			const start = gpuStartMs === null ? gpuTime : BigInt( gpuStartMs * 1e6 );
			const end = start + BigInt( duration * 1e6 );
			gpuTime = end;
			pending.set( uid, { type, duration, range: { start, end } } );
			for ( const listener of listeners ) listener( type, uid, label );

		},
		resolve( type ) {

			for ( const [ uid, entry ] of pending ) {

				if ( entry.type === type ) {

					resolved.set( uid, entry.duration );
					resolvedRanges.set( uid, entry.range );
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
		assert.deepEqual( ProfilerService.exportGpuJSON(), [ stats ], 'GPU JSON export is separate' );

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
