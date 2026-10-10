// WITH_GENESYS
import { ProfilerService, profileGpuBlock } from 'three';
import { CONSOLE_LEVEL } from '../../utils/console-wrapper.js';
import {
	captureConsole,
	createCommonRenderer,
	createLegacyWebGLRenderer,
	delay,
	findPartialOverlaps,
	nextFrame,
	useRealPerformance,
} from './ProfilerTestUtils.js';

export default QUnit.module( 'Profiler', () => {

	QUnit.module( 'ProfilerService GPU', hooks => {

		let restorePerformance;

		hooks.beforeEach( () => {

			console.level = CONSOLE_LEVEL.ERROR;
			restorePerformance = useRealPerformance();
			ProfilerService.setProfile( 'full' );
			ProfilerService.enable();

		} );

		hooks.afterEach( () => {

			ProfilerService.disable();
			ProfilerService.setProfile( 'full' );
			ProfilerService.setGpuDetail( 'pass' );
			restorePerformance();
			console.level = CONSOLE_LEVEL.DEFAULT;

		} );

		QUnit.module( 'attachGpuRenderer', () => {

			QUnit.test( 'refuses while disabled or without a supported renderer', async assert => {

				ProfilerService.disable();
				assert.false( await ProfilerService.attachGpuRenderer( createCommonRenderer() ), 'disabled profiler' );

				ProfilerService.enable();
				assert.false( await ProfilerService.attachGpuRenderer( null ), 'null renderer' );
				assert.false( await ProfilerService.attachGpuRenderer( undefined ), 'undefined renderer' );
				assert.false( await ProfilerService.attachGpuRenderer( {} ), 'unsupported renderer' );

			} );

			QUnit.test( 'is idempotent for an attached renderer', async assert => {

				const renderer = createCommonRenderer();
				assert.true( await ProfilerService.attachGpuRenderer( renderer ), 'first attach' );
				assert.true( await ProfilerService.attachGpuRenderer( renderer ), 'second attach returns cached availability' );
				assert.strictEqual( renderer.backend.listeners.size, 1, 'one timestamp listener' );

			} );

			QUnit.test( 'reports unavailable when the device lacks timestamp-query', async assert => {

				const renderer = createCommonRenderer( { timestampFeature: false } );

				assert.false( await ProfilerService.attachGpuRenderer( renderer ), 'unavailable' );
				assert.strictEqual( renderer.backend.listeners.size, 0, 'no listener registered' );
				assert.strictEqual( ProfilerService.beginGpu( 'unavailable', renderer )._seq, 0, 'GPU span is a no-op' );

			} );

			QUnit.test( 'restores common-renderer timestamp tracking on disable', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );
				assert.true( renderer.backend.trackTimestamp, 'tracking enabled while attached' );

				ProfilerService.disable();
				assert.false( renderer.backend.trackTimestamp, 'previous tracking state restored' );
				assert.strictEqual( renderer.backend.listeners.size, 0, 'timestamp listener removed' );

			} );

			QUnit.test( 'leaves trackTimestamp untouched when timestamps are unavailable', async assert => {

				const renderer = createCommonRenderer( { timestampFeature: false } );
				await ProfilerService.attachGpuRenderer( renderer );

				assert.false( renderer.backend.trackTimestamp, 'tracking not forced on' );

			} );

			QUnit.test( 'disable() during attach leaves no listener behind', async assert => {

				let releaseInit;
				const initGate = new Promise( resolve => {

					releaseInit = resolve;

				} );
				const renderer = createCommonRenderer( { init: () => initGate } );

				const attaching = ProfilerService.attachGpuRenderer( renderer );
				ProfilerService.disable();
				releaseInit();
				await attaching;

				assert.strictEqual( renderer.backend.listeners.size, 0, 'no listener attached while disabled' );
				assert.false( renderer.backend.trackTimestamp, 'tracking not left on while disabled' );

			} );

			QUnit.test( 'concurrent attach calls register one listener', async assert => {

				let releaseInit;
				const initGate = new Promise( resolve => {

					releaseInit = resolve;

				} );
				const renderer = createCommonRenderer( { init: () => initGate } );

				const first = ProfilerService.attachGpuRenderer( renderer );
				const second = ProfilerService.attachGpuRenderer( renderer );
				releaseInit();
				await Promise.all( [ first, second ] );

				assert.strictEqual( renderer.backend.listeners.size, 1, 'one timestamp listener' );
				ProfilerService.disable();
				assert.false( renderer.backend.trackTimestamp, 'original tracking state restored' );

			} );

		} );

		QUnit.module( 'common renderer', () => {

			QUnit.test( 'collects labelled common-renderer GPU spans', async assert => {

				const renderer = createCommonRenderer();
				assert.true( await ProfilerService.attachGpuRenderer( renderer ), 'renderer supports timestamps' );

				profileGpuBlock( 'gpu-pass', renderer, () => {

					renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
					renderer.backend.emit( 'compute', 'c:0:2:f1', 3 );

				} );
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

			QUnit.test( 'commits nothing for spans without timestamp queries', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				profileGpuBlock( 'empty', renderer, () => {} );
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'empty' ), null, 'no sample' );
				assert.strictEqual( renderer.backend.resolveCalls, 0, 'nothing to resolve' );

			} );

			QUnit.test( 'profileGpuBlock() collects labelled GPU spans', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const value = profileGpuBlock( 'gpu-block', renderer, () => {

					renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
					return 7;

				} );

				assert.strictEqual( value, 7, 'return value preserved' );
				await ProfilerService.flushGpu( renderer );

				const stats = ProfilerService.getGpuStats( 'gpu-block' );
				assert.strictEqual( stats.samples, 1, 'one sample committed' );
				assert.strictEqual( stats.avg, 2, 'render duration is preserved' );

			} );

			QUnit.test( 'profileGpuBlock() keeps the span open until a thenable settles', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				await profileGpuBlock( 'gpu-async', renderer, async () => {

					await delay( 0 );
					renderer.backend.emit( 'render', 'r:0:1:f1', 4 );

				} );

				await ProfilerService.flushGpu( renderer );

				const stats = ProfilerService.getGpuStats( 'gpu-async' );
				assert.strictEqual( stats.samples, 1, 'one sample committed' );
				assert.strictEqual( stats.avg, 4, 'post-await GPU work is inside the span' );

			} );

			QUnit.test( 'profileGpuBlock() runs directly while disabled', assert => {

				const renderer = createCommonRenderer();
				ProfilerService.disable();

				assert.strictEqual( profileGpuBlock( 'gpu-block', renderer, () => 3 ), 3, 'sync value preserved' );
				assert.deepEqual( ProfilerService.getAllGpuStats(), [], 'no GPU samples' );

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
				const parentEvent = trace.traceEvents.find( event => event.name === 'gpu-frame' );
				const first = trace.traceEvents.find( event => event.name === 'GPU pass: First' );
				const second = trace.traceEvents.find( event => event.name === 'GPU pass: Second' );

				assert.strictEqual( first.dur, 2000, 'first pass uses its GPU duration' );
				assert.strictEqual( second.ts - first.ts, 5000, 'pass starts preserve the GPU timestamp gap' );
				assert.true( parentEvent.ts <= first.ts, 'parent slice starts at the GPU envelope start' );
				assert.true( parentEvent.ts + parentEvent.dur >= second.ts + second.dur, 'parent slice spans the GPU envelope' );

			} );

			QUnit.test( 'parent GPU stats use summed busy time, not the start/end envelope', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const parent = ProfilerService.beginGpu( 'gpu-frame', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2, 'First', 10 );
				renderer.backend.emit( 'render', 'r:1:2:f1', 1, 'Second', 15 );
				ProfilerService.endGpu( parent );
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'gpu-frame' ).avg, 3, '2 ms + 1 ms of GPU work, excluding the 3 ms idle gap' );

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

			QUnit.test( 'a pass takes the name of the innermost span that only times it', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const outer = ProfilerService.beginGpu( 'outer', renderer );
				const inner = ProfilerService.beginGpu( 'inner', renderer, 'Inner (1920x1080)' );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2, 'Scene', 10 );
				ProfilerService.endGpu( inner );
				ProfilerService.endGpu( outer );
				await ProfilerService.flushGpu( renderer );

				const gpuSlices = ProfilerService.exportChromeTrace().traceEvents.filter( event => event.ph === 'X' && event.tid === 3 );
				assert.deepEqual( gpuSlices.map( event => event.name ), [ 'Inner (1920x1080)' ], 'one slice instead of three identical ones' );
				for ( const label of [ 'outer', 'inner', 'GPU pass: Scene' ] ) {

					assert.strictEqual( ProfilerService.getGpuStats( label )?.avg, 2, `stats keep ${ label }` );

				}

			} );

			QUnit.test( 'leaves out a span that repeats a deeper span and names a group\'s own pass', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const stage = ProfilerService.beginGpu( 'DepthOfFieldNode.updateBefore', renderer, 'Depth Of Field' );
				const output = ProfilerService.beginGpu( 'Renderer.render (Output)', renderer, 'Output (RTT, 64x64)' );
				const blur = ProfilerService.beginGpu( 'Renderer.render (Blur)', renderer, 'Blur (Quad, 32x32)' );
				renderer.backend.emit( 'render', 'r:0:1:f1', 1, 'Blur', 10 );
				ProfilerService.endGpu( blur );
				renderer.backend.emit( 'render', 'r:1:2:f1', 2, 'Output', 12 );
				ProfilerService.endGpu( output );
				ProfilerService.endGpu( stage );
				await ProfilerService.flushGpu( renderer );

				const gpuSlices = ProfilerService.exportChromeTrace().traceEvents.filter( event => event.ph === 'X' && event.tid === 3 );
				assert.deepEqual(
					gpuSlices.map( event => event.name ),
					[ 'Output (RTT, 64x64)', 'Blur (Quad, 32x32)', 'Output (pass)' ],
					'the stage span adds nothing over the render span, and the render\'s own pass reads apart from it'
				);
				assert.strictEqual( ProfilerService.getGpuStats( 'DepthOfFieldNode.updateBefore' )?.avg, 3, 'stats keep the left-out span' );

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

			QUnit.test( 'back-to-back nested renders do not overlap their siblings', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const scene = ProfilerService.beginGpu( 'Renderer.render (Scene)', renderer );
				const shadowA = ProfilerService.beginGpu( 'Renderer.render (Shadow A)', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 3.8, 'Shadow A', 10 );
				ProfilerService.endGpu( shadowA );
				const shadowB = ProfilerService.beginGpu( 'Renderer.render (Shadow B)', renderer );
				renderer.backend.emit( 'render', 'r:1:2:f1', 3.4, 'Shadow B', 13.8 );
				ProfilerService.endGpu( shadowB );
				renderer.backend.emit( 'render', 'r:2:3:f1', 6, 'Scene', 17.3 );
				ProfilerService.endGpu( scene );
				await ProfilerService.flushGpu( renderer );

				const events = ProfilerService.exportChromeTrace().traceEvents;
				assert.deepEqual( findPartialOverlaps( events ), [], 'every GPU slice nests' );
				assert.deepEqual(
					events.filter( event => event.ph === 'X' ).map( event => event.name ),
					[
						'Renderer.render (Scene)',
						'Renderer.render (Shadow A)',
						'Renderer.render (Shadow B)',
						'Scene (pass)',
					],
					'single-pass renders are one slice each, and the scene\'s own pass reads apart from its render'
				);

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

			QUnit.test( 'omits zero-length GPU passes from the trace but keeps their stats', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const parent = ProfilerService.beginGpu( 'renderPipeline', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 1, 'AO', 10 );
				renderer.backend.emit( 'render', 'r:1:2:f1', 0.0002, 'Clear', 11 );
				ProfilerService.endGpu( parent );
				await ProfilerService.flushGpu( renderer );

				const names = ProfilerService.exportChromeTrace().traceEvents.filter( event => event.ph === 'X' ).map( event => event.name );
				assert.false( names.includes( 'GPU pass: Clear' ), 'sub-µs pass not traced' );
				assert.true( names.includes( 'GPU pass: AO' ), 'other passes still traced' );
				assert.strictEqual( ProfilerService.getGpuStats( 'GPU pass: Clear' ).samples, 1, 'sub-µs pass still counted' );

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

			QUnit.test( 'stats profile keeps GPU stats but records no GPU trace', async assert => {

				ProfilerService.setProfile( 'stats' );
				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'stats-gpu', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				ProfilerService.endGpu( span );
				await ProfilerService.flushGpu( renderer );

				assert.ok( ProfilerService.getGpuStats( 'stats-gpu' ), 'GPU stats collected' );
				assert.false(
					ProfilerService.exportChromeTrace().traceEvents.some( event => event.ph === 'X' && event.tid === 3 ),
					'no GPU trace events'
				);

			} );

			QUnit.test( 'concurrent flushGpu() calls share one resolve', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'shared-flush', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				ProfilerService.endGpu( span );
				await Promise.all( [ ProfilerService.flushGpu( renderer ), ProfilerService.flushGpu( renderer ) ] );

				assert.strictEqual( renderer.backend.resolveCalls, 1, 'one resolve' );
				assert.strictEqual( ProfilerService.getGpuStats( 'shared-flush' ).samples, 1, 'one sample' );

			} );

			QUnit.test( 'flushes automatically on the next animation frame', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'auto-flush', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				ProfilerService.endGpu( span );
				await nextFrame();

				assert.ok( ProfilerService.getGpuStats( 'auto-flush' ), 'committed without an explicit flushGpu()' );

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

			QUnit.test( 'report() prints a separate GPU table', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'report-gpu', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				ProfilerService.endGpu( span );
				await ProfilerService.flushGpu( renderer );

				const table = captureConsole( 'table' );
				try {

					ProfilerService.report();

				} finally {

					table.restore();

				}

				const gpuRows = table.calls[ table.calls.length - 1 ][ 0 ];
				assert.true( gpuRows.some( row => row.label === 'report-gpu' && row[ 'avg ms' ] === '2.000' ), 'GPU row printed' );

			} );

			QUnit.test( 'retries spans whose timestamps were not resolved yet', async assert => {

				const renderer = createCommonRenderer( { deferResolves: 1 } );
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'late', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				ProfilerService.endGpu( span );
				await ProfilerService.flushGpu( renderer );
				assert.strictEqual( ProfilerService.getGpuStats( 'late' ), null, 'not resolved on the first flush' );

				await ProfilerService.flushGpu( renderer );
				assert.ok( ProfilerService.getGpuStats( 'late' ), 'committed once the timestamps resolve' );

			} );

			QUnit.test( 'gives up on spans whose timestamps never resolve', async assert => {

				const renderer = createCommonRenderer( { deferResolves: Infinity } );
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'never', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				ProfilerService.endGpu( span );
				for ( let i = 0; i < 3; i ++ ) await ProfilerService.flushGpu( renderer );
				const resolveCalls = renderer.backend.resolveCalls;
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( renderer.backend.resolveCalls, resolveCalls, 'span dropped after retries: nothing left to resolve' );
				assert.strictEqual( ProfilerService.getGpuStats( 'never' ), null, 'no sample' );

			} );

			QUnit.test( 'ignores unlabeled queries outside any span', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				for ( let i = 0; i < 50; i ++ ) renderer.backend.emit( 'render', `r:${i}:1:f1`, 0.1 );
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( renderer.backend.resolveCalls, 0, 'nothing queued to resolve' );
				assert.deepEqual( ProfilerService.getAllGpuStats(), [], 'no samples' );

			} );

			QUnit.test( 'waits for every query of a span before committing it', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );
				const resolve = renderer.backend.resolve;
				let computeResolves = 0;
				renderer.backend.resolve = type => {

					// The compute pool skips its first resolve, e.g. while its buffer is mapped.
					if ( type === 'compute' && computeResolves ++ === 0 ) return;
					resolve( type );

				};

				const span = ProfilerService.beginGpu( 'mixed', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				renderer.backend.emit( 'compute', 'c:0:2:f1', 3 );
				ProfilerService.endGpu( span );
				await ProfilerService.flushGpu( renderer );
				assert.strictEqual( ProfilerService.getGpuStats( 'mixed' ), null, 'not committed with a query missing' );

				await ProfilerService.flushGpu( renderer );
				assert.strictEqual( ProfilerService.getGpuStats( 'mixed' ).avg, 5, 'committed with both queries' );

			} );

			QUnit.test( 'keeps timestamps read before a retry', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );
				const resolve = renderer.backend.resolve;
				let computeResolves = 0;
				renderer.backend.resolve = type => {

					if ( type === 'compute' && computeResolves ++ === 0 ) return;
					resolve( type );

				};

				const render = ProfilerService.beginGpu( 'render-only', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				ProfilerService.endGpu( render );
				const compute = ProfilerService.beginGpu( 'compute-only', renderer );
				renderer.backend.emit( 'compute', 'c:0:2:f1', 3 );
				ProfilerService.endGpu( compute );
				await ProfilerService.flushGpu( renderer );
				assert.strictEqual( ProfilerService.getGpuStats( 'render-only' ), null, 'the batch waits for the compute query' );

				// The second render resolve replaces the timestamp read on the first flush.
				await ProfilerService.flushGpu( renderer );
				assert.strictEqual( ProfilerService.getGpuStats( 'render-only' )?.avg, 2, 'render span keeps its first read' );
				assert.strictEqual( ProfilerService.getGpuStats( 'compute-only' )?.avg, 3, 'compute span resolved on retry' );

			} );

			QUnit.test( 'commits resolved spans when another span in the batch never resolves', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );
				const resolve = renderer.backend.resolve;
				renderer.backend.resolve = type => {

					if ( type !== 'compute' ) resolve( type );

				};

				const render = ProfilerService.beginGpu( 'render-only', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 2 );
				ProfilerService.endGpu( render );
				const compute = ProfilerService.beginGpu( 'compute-only', renderer );
				renderer.backend.emit( 'compute', 'c:0:2:f1', 3 );
				ProfilerService.endGpu( compute );
				for ( let i = 0; i < 3; i ++ ) await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'render-only' )?.avg, 2, 'resolved span committed after the retry limit' );
				assert.strictEqual( ProfilerService.getGpuStats( 'compute-only' ), null, 'unresolved span dropped' );

			} );

			QUnit.test( 'counts a pass once when the backend reports the same query twice', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				// One render context restarted mid-pass: the backend notifies the same uid per allocation.
				renderer.backend.emit( 'render', 'r:0:1:f1', 2, 'Shadow', 10 );
				renderer.backend.emit( 'render', 'r:0:1:f1', 1, 'Shadow', 13 );
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'GPU pass: Shadow' ).samples, 1, 'one sample per pass' );

			} );

		} );

		QUnit.module( 'in-pass spans', () => {

			const gpuSlices = trace => trace.traceEvents.filter( event => event.ph === 'X' );

			QUnit.test( 'nests stage and draw spans inside their pass', async assert => {

				const renderer = createCommonRenderer( { passTimestamps: true } );
				await ProfilerService.attachGpuRenderer( renderer );

				renderer.backend.emit( 'render', 'r:0:1:f1', 6, 'Scene', 10 );
				renderer.backend.emit( 'render', 'p:1:1:f1', 3, 'Opaque', 11, { parentUid: 'r:0:1:f1' } );
				renderer.backend.emit( 'render', 'p:2:1:f1', 2, 'Floor (Standard)', 11.5, { parentUid: 'p:1:1:f1' } );
				renderer.backend.emit( 'render', 'p:3:1:f1', 1, 'Transparent', 14, { parentUid: 'r:0:1:f1' } );
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'GPU pass: Scene' ).avg, 6, 'pass keeps its own time' );
				assert.strictEqual( ProfilerService.getGpuStats( 'GPU pass: Scene / Opaque' ).avg, 3, 'stage keyed under its pass' );
				assert.strictEqual( ProfilerService.getGpuStats( 'GPU pass: Scene / Opaque / Floor (Standard)' ).avg, 2, 'draw keyed under its stage' );
				assert.strictEqual( ProfilerService.getGpuStats( 'GPU pass: Scene / Transparent' ).avg, 1, 'sibling stage keyed under the pass' );

				const slices = gpuSlices( ProfilerService.exportChromeTrace() );
				assert.deepEqual( slices.map( slice => slice.name ), [ 'GPU pass: Scene', 'Opaque', 'Floor (Standard)', 'Transparent' ], 'short names, parents first' );
				assert.deepEqual( findPartialOverlaps( slices ), [], 'every span nests' );

				const [ scene, opaque, floor ] = slices;
				assert.ok( opaque.ts >= scene.ts && opaque.ts + opaque.dur <= scene.ts + scene.dur, 'stage inside its pass' );
				assert.ok( floor.ts >= opaque.ts && floor.ts + floor.dur <= opaque.ts + opaque.dur, 'draw inside its stage' );

			} );

			QUnit.test( 'nested spans do not add to the busy time of a GPU span', async assert => {

				const renderer = createCommonRenderer( { passTimestamps: true } );
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'Renderer.render (Scene)', renderer );
				renderer.backend.emit( 'render', 'r:0:1:f1', 6, 'Scene', 10 );
				renderer.backend.emit( 'render', 'p:1:1:f1', 4, 'Opaque', 11, { parentUid: 'r:0:1:f1' } );
				ProfilerService.endGpu( span );
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'Renderer.render (Scene)' ).avg, 6, 'only the pass counts' );

			} );

			QUnit.test( 'drops a span whose pass is unknown', async assert => {

				const renderer = createCommonRenderer( { passTimestamps: true } );
				await ProfilerService.attachGpuRenderer( renderer );

				renderer.backend.emit( 'render', 'r:0:1:f1', 6, 'Scene', 10 );
				renderer.backend.emit( 'render', 'p:1:2:f1', 2, 'Opaque', 11, { parentUid: 'r:9:2:f1' } );
				await ProfilerService.flushGpu( renderer );

				assert.ok( ProfilerService.getGpuStats( 'GPU pass: Scene' ), 'pass recorded' );
				assert.deepEqual( gpuSlices( ProfilerService.exportChromeTrace() ).map( slice => slice.name ), [ 'GPU pass: Scene' ], 'orphan span not traced' );

			} );

			QUnit.test( 'clips nested spans to their snapped pass', async assert => {

				const renderer = createCommonRenderer( { passTimestamps: true } );
				await ProfilerService.attachGpuRenderer( renderer );

				renderer.backend.emit( 'render', 'r:0:1:f1', 4, 'AO', 10 );
				// Overlaps AO, so its trace slice starts where AO ends (14 ms).
				renderer.backend.emit( 'render', 'r:1:2:f1', 4, 'Scene', 12 );
				renderer.backend.emit( 'render', 'p:1:2:f1', 1, 'Early', 12, { parentUid: 'r:1:2:f1' } );
				renderer.backend.emit( 'render', 'p:2:2:f1', 3.5, 'Late', 13, { parentUid: 'r:1:2:f1' } );
				renderer.backend.emit( 'render', 'p:3:2:f1', 0.4, 'Draw', 15, { parentUid: 'p:2:2:f1' } );
				await ProfilerService.flushGpu( renderer );

				const slices = gpuSlices( ProfilerService.exportChromeTrace() );
				assert.deepEqual( findPartialOverlaps( slices ), [], 'every span nests' );

				const byName = name => slices.find( slice => slice.name === name );
				const scene = byName( 'GPU pass: Scene' );
				const late = byName( 'Late' );
				const draw = byName( 'Draw' );
				assert.strictEqual( byName( 'Early' ), undefined, 'span before the snapped pass is not traced' );
				assert.strictEqual( ProfilerService.getGpuStats( 'GPU pass: Scene / Early' ).avg, 1, 'untraced span keeps its stats' );
				assert.strictEqual( late.ts, scene.ts, 'clipped to the pass start' );
				assert.strictEqual( late.ts + late.dur, scene.ts + scene.dur, 'clipped to the pass end' );
				assert.ok( draw.ts >= late.ts && draw.ts + draw.dur <= late.ts + late.dur, 'draw inside its clipped stage' );

			} );

			QUnit.test( 'setGpuDetail() drives the backend level and disable() restores it', async assert => {

				const renderer = createCommonRenderer( { passTimestamps: true } );
				ProfilerService.setGpuDetail( 'stage' );
				await ProfilerService.attachGpuRenderer( renderer );

				assert.true( ProfilerService.hasPassTimestamps( renderer ), 'support detected' );
				assert.strictEqual( renderer.backend.passTimestampLevel, 1, 'stage level applied on attach' );

				ProfilerService.setGpuDetail( 'draw' );
				assert.strictEqual( ProfilerService.getGpuDetail(), 'draw' );
				assert.strictEqual( renderer.backend.passTimestampLevel, 2, 'draw level applied to an attached renderer' );

				ProfilerService.disable();
				assert.strictEqual( renderer.backend.passTimestampLevel, 0, 'previous level restored' );

			} );

			QUnit.test( 'leaves backends without in-pass timestamps at pass detail', async assert => {

				const renderer = createCommonRenderer();
				ProfilerService.setGpuDetail( 'draw' );
				const warnings = captureConsole( 'warn' );

				try {

					await ProfilerService.attachGpuRenderer( renderer );

				} finally {

					warnings.restore();

				}

				assert.false( ProfilerService.hasPassTimestamps( renderer ), 'no support' );
				assert.strictEqual( renderer.backend.passTimestampLevel, 0, 'level untouched' );
				assert.true( warnings.calls.some( args => String( args[ 0 ] ).includes( 'enable-unsafe-webgpu' ) ), 'warns how to enable it' );

			} );

			QUnit.test( 'setGpuDetail() warns when an attached backend cannot time inside passes', async assert => {

				const renderer = createCommonRenderer();
				await ProfilerService.attachGpuRenderer( renderer );
				const warnings = captureConsole( 'warn' );

				try {

					ProfilerService.setGpuDetail( 'stage' );

				} finally {

					warnings.restore();

				}

				assert.strictEqual( renderer.backend.passTimestampLevel, 0, 'level untouched' );
				assert.true( warnings.calls.some( args => String( args[ 0 ] ).includes( '"stage"' ) ), 'warns for the requested detail' );

			} );

			QUnit.test( 'setGpuDetail() ignores unknown values', assert => {

				const warnings = captureConsole( 'warn' );

				try {

					ProfilerService.setGpuDetail( 'toString' );

				} finally {

					warnings.restore();

				}

				assert.strictEqual( ProfilerService.getGpuDetail(), 'pass' );

			} );

		} );

		QUnit.module( 'legacy WebGLRenderer', () => {

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

			QUnit.test( 'polls until the query result is available', async assert => {

				const renderer = createLegacyWebGLRenderer( { availableAfterPolls: 3 } );
				await ProfilerService.attachGpuRenderer( renderer );

				ProfilerService.endGpu( ProfilerService.beginGpu( 'polled', renderer ) );
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'polled' ).avg, 4, 'result read once available' );
				assert.strictEqual( renderer.gl.createdQueries[ 0 ].polls, 4, 'polled until available' );

			} );

			QUnit.test( 'polls on a 4 ms timeout without requestAnimationFrame', async assert => {

				const renderer = createLegacyWebGLRenderer( { availableAfterPolls: 1 } );
				await ProfilerService.attachGpuRenderer( renderer );

				const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
				const originalSetTimeout = globalThis.setTimeout;
				const delays = [];
				globalThis.requestAnimationFrame = undefined;
				globalThis.setTimeout = ( callback, ms, ...args ) => {

					delays.push( ms );
					return originalSetTimeout( callback, ms, ...args );

				};

				try {

					ProfilerService.endGpu( ProfilerService.beginGpu( 'polled', renderer ) );
					await ProfilerService.flushGpu( renderer );

				} finally {

					globalThis.requestAnimationFrame = originalRequestAnimationFrame;
					globalThis.setTimeout = originalSetTimeout;

				}

				assert.strictEqual( ProfilerService.getGpuStats( 'polled' ).avg, 4, 'result read once available' );
				assert.true( delays.length > 0, 'fell back to setTimeout' );
				assert.deepEqual( [ ...new Set( delays ) ], [ 4 ], 'every fallback waits 4 ms' );

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

			QUnit.test( 'returns a no-op span when beginQuery throws', async assert => {

				const renderer = createLegacyWebGLRenderer( { beginQueryThrows: true } );
				await ProfilerService.attachGpuRenderer( renderer );

				assert.strictEqual( ProfilerService.beginGpu( 'throws', renderer )._seq, 0, 'no-op span' );
				assert.strictEqual( renderer.gl.deletedQueries.size, 1, 'allocated query deleted' );

			} );

			QUnit.test( 'drops and deletes queries when the context is lost', async assert => {

				const renderer = createLegacyWebGLRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'lost', renderer );
				ProfilerService.endGpu( span );
				renderer.gl.contextLost = true;
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'lost' ), null, 'no sample' );
				assert.true( renderer.gl.deletedQueries.has( span._query ), 'query deleted' );

			} );

			QUnit.test( 'disable() ends and deletes an active query', async assert => {

				const renderer = createLegacyWebGLRenderer();
				await ProfilerService.attachGpuRenderer( renderer );

				const span = ProfilerService.beginGpu( 'open', renderer );
				ProfilerService.disable();

				assert.strictEqual( renderer.gl.activeQuery, null, 'query ended' );
				assert.true( renderer.gl.deletedQueries.has( span._query ), 'query deleted' );

			} );

			QUnit.test( 'reset() during an in-flight flush deletes queued queries', async assert => {

				const renderer = createLegacyWebGLRenderer( { availableAfterPolls: 3 } );
				await ProfilerService.attachGpuRenderer( renderer );

				ProfilerService.endGpu( ProfilerService.beginGpu( 'in-flight', renderer ) );
				const flushing = ProfilerService.flushGpu( renderer );
				const queued = ProfilerService.beginGpu( 'queued', renderer );
				ProfilerService.endGpu( queued );
				ProfilerService.reset();

				assert.true( renderer.gl.deletedQueries.has( queued._query ), 'queued query deleted on reset' );
				await flushing;

			} );

			QUnit.test( 'a polling error does not wedge later flushes', async assert => {

				const renderer = createLegacyWebGLRenderer( { availableAfterPolls: 5, throwOnPoll: 2 } );
				await ProfilerService.attachGpuRenderer( renderer );

				ProfilerService.endGpu( ProfilerService.beginGpu( 'poll-error', renderer ) );
				const flushing = ProfilerService.flushGpu( renderer );
				const settled = await Promise.race( [
					flushing.then( () => true, () => true ),
					delay( 250 ).then( () => false ),
				] );

				assert.true( settled, 'flushGpu() settles after a polling error' );
				if ( settled === false ) return;

				ProfilerService.endGpu( ProfilerService.beginGpu( 'after-error', renderer ) );
				await ProfilerService.flushGpu( renderer );
				assert.ok( ProfilerService.getGpuStats( 'after-error' ), 'later spans still resolve' );

			} );

			QUnit.test( 'a disjoint event seen while polling discards the sample', async assert => {

				const renderer = createLegacyWebGLRenderer( { availableAfterPolls: 1, disjointSequence: [ true ] } );
				await ProfilerService.attachGpuRenderer( renderer );

				ProfilerService.endGpu( ProfilerService.beginGpu( 'disjoint-early', renderer ) );
				await ProfilerService.flushGpu( renderer );

				assert.strictEqual( ProfilerService.getGpuStats( 'disjoint-early' ), null, 'sample discarded' );

			} );

		} );

	} );

} );
// !WITH_GENESYS
