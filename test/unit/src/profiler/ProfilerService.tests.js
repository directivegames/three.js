// WITH_GENESYS
import { ProfilerService } from 'three';
import { CONSOLE_LEVEL } from '../../utils/console-wrapper.js';
import {
	assertClose,
	captureConsole,
	clearGnsxMarks,
	countGnsxUserTimingEntries,
	findPartialOverlaps,
	installFakeClock,
	useRealPerformance,
} from './ProfilerTestUtils.js';

// Captured at import time, before any suite has called enable().
const profilerGlobalAtImport = typeof window !== 'undefined' ? window.__gnsx_profiler : undefined;

export default QUnit.module( 'Profiler', () => {

	QUnit.module( 'ProfilerService', hooks => {

		let clock;
		let restorePerformance;

		function recordScope( label, durationMs ) {

			ProfilerService.begin( label );
			clock.advance( durationMs );
			ProfilerService.end( label );

		}

		function sliceEvents() {

			return ProfilerService.exportChromeTrace().traceEvents.filter( event => event.ph === 'X' );

		}

		hooks.beforeEach( () => {

			console.level = CONSOLE_LEVEL.ERROR;
			restorePerformance = useRealPerformance();
			clock = installFakeClock( 1000 );

		} );

		hooks.afterEach( () => {

			ProfilerService.disable();
			ProfilerService.setProfile( 'full' );
			clock.restore();
			restorePerformance();
			console.level = CONSOLE_LEVEL.DEFAULT;

		} );

		QUnit.module( 'lifecycle', () => {

			QUnit.test( 'records nothing while disabled', assert => {

				assert.false( ProfilerService.isEnabled(), 'disabled by default' );

				recordScope( 'idle', 1 );
				const span = ProfilerService.beginSpan( 'idle-span' );
				ProfilerService.endSpan( span );

				assert.strictEqual( span._seq, 0, 'beginSpan returns the shared no-op handle' );
				assert.true( Object.isFrozen( span ), 'no-op span handle is frozen' );
				assert.strictEqual( ProfilerService.beginGpu( 'idle-gpu', {} )._seq, 0, 'beginGpu returns the no-op handle' );
				assert.deepEqual( ProfilerService.getAllStats(), [], 'no stats collected' );
				assert.strictEqual( ProfilerService.traceEvents.length, 0, 'no trace events collected' );

			} );

			QUnit.test( 'enable() starts recording and disable() stops and clears', assert => {

				ProfilerService.enable();
				assert.true( ProfilerService.isEnabled(), 'enabled' );
				recordScope( 'session', 1 );
				assert.ok( ProfilerService.getStats( 'session' ), 'sample recorded while enabled' );

				ProfilerService.disable();
				assert.false( ProfilerService.isEnabled(), 'disabled' );
				assert.deepEqual( ProfilerService.getAllStats(), [], 'stats cleared on disable' );
				assert.strictEqual( ProfilerService.traceEvents.length, 0, 'trace cleared on disable' );

				recordScope( 'session', 1 );
				assert.strictEqual( ProfilerService.getStats( 'session' ), null, 'recording stops after disable' );

			} );

			QUnit.test( 'enable() on an enabled profiler starts a fresh session', assert => {

				ProfilerService.enable();
				recordScope( 'first-session', 1 );
				clock.advance( 10 );
				ProfilerService.enable();
				recordScope( 'second-session', 1 );

				assert.strictEqual( ProfilerService.getStats( 'first-session' ), null, 'previous samples dropped' );
				assert.strictEqual( sliceEvents()[ 0 ].ts, 0, 'trace timestamps restart from the new session' );

			} );

			QUnit.test( 'reset() clears samples and trace but keeps recording', assert => {

				ProfilerService.enable();
				recordScope( 'before-reset', 1 );
				ProfilerService.reset();

				assert.true( ProfilerService.isEnabled(), 'still enabled' );
				assert.strictEqual( ProfilerService.getStats( 'before-reset' ), null, 'samples cleared' );
				assert.strictEqual( ProfilerService.traceEvents.length, 0, 'trace cleared' );

				recordScope( 'after-reset', 1 );
				assert.ok( ProfilerService.getStats( 'after-reset' ), 'records after reset' );

			} );

			QUnit.test( 'setProfile() / getProfile()', assert => {

				assert.strictEqual( ProfilerService.getProfile(), 'full', 'full is the default profile' );
				ProfilerService.setProfile( 'stats' );
				assert.strictEqual( ProfilerService.getProfile(), 'stats', 'profile updated' );

			} );

			QUnit.test( 'isTracing() is true only while enabled with the full profile', assert => {

				assert.false( ProfilerService.isTracing(), 'disabled' );
				ProfilerService.enable();
				assert.true( ProfilerService.isTracing(), 'full profile' );
				ProfilerService.setProfile( 'stats' );
				assert.false( ProfilerService.isTracing(), 'stats profile' );

			} );

			QUnit.test( 'exposes window.__gnsx_profiler once enabled', assert => {

				ProfilerService.enable();
				assert.strictEqual( window.__gnsx_profiler, ProfilerService, 'global points at the singleton' );

			} );

			QUnit.test( 'is reachable as window.__gnsx_profiler before it is enabled', assert => {

				assert.strictEqual(
					profilerGlobalAtImport,
					ProfilerService,
					'the documented console quick start calls __gnsx_profiler.enable()'
				);

			} );

		} );

		QUnit.module( 'CPU scopes', innerHooks => {

			innerHooks.beforeEach( () => ProfilerService.enable() );

			QUnit.test( 'records inclusive duration for begin() / end() pairs', assert => {

				recordScope( 'scope', 2 );
				recordScope( 'scope', 4 );

				const stats = ProfilerService.getStats( 'scope' );
				assert.strictEqual( stats.samples, 2, 'two samples' );
				assert.strictEqual( stats.avg, 3, 'average' );
				assert.strictEqual( stats.min, 2, 'min' );
				assert.strictEqual( stats.max, 4, 'max' );
				assert.strictEqual( stats.totalInvocations, 2, 'invocation count' );

			} );

			QUnit.test( 'ignores end() without a matching begin()', assert => {

				ProfilerService.end( 'ghost' );

				assert.strictEqual( ProfilerService.getStats( 'ghost' ), null, 'no sample' );
				assert.strictEqual( ProfilerService.traceEvents.length, 0, 'no trace event' );

			} );

			QUnit.test( 'pairs recursive scopes with the same label last-in first-out', assert => {

				ProfilerService.begin( 'recurse' );
				clock.advance( 1 );
				ProfilerService.begin( 'recurse' );
				clock.advance( 2 );
				ProfilerService.end( 'recurse' );
				clock.advance( 3 );
				ProfilerService.end( 'recurse' );

				const stats = ProfilerService.getStats( 'recurse' );
				assert.strictEqual( stats.selfMin, 2, 'inner self time' );
				assert.strictEqual( stats.selfMax, 4, 'outer self time excludes the inner call' );

			} );

			QUnit.test( 'recursive calls add inclusive time once, from the outermost call', assert => {

				ProfilerService.begin( 'recurse' );
				clock.advance( 1 );
				ProfilerService.begin( 'recurse' );
				clock.advance( 2 );
				ProfilerService.end( 'recurse' );
				clock.advance( 3 );
				ProfilerService.end( 'recurse' );

				const stats = ProfilerService.getStats( 'recurse' );
				assert.strictEqual( stats.samples, 1, 'the inner call is already inside the outer one' );
				assert.strictEqual( stats.avg, 6, 'outer call' );
				assert.strictEqual( stats.selfAvg, 3, 'self time still covers both calls' );
				assert.strictEqual( stats.totalInvocations, 2, 'both calls are counted' );
				assert.deepEqual( ProfilerService.getValidSamples( 'recurse' ), [ 6 ], 'no placeholder for the inner call' );

			} );

			QUnit.test( 'a span inside a scope with the same label is a recursive call', assert => {

				ProfilerService.begin( 'update' );
				clock.advance( 1 );
				const span = ProfilerService.beginSpan( 'update' );
				clock.advance( 2 );
				ProfilerService.endSpan( span );
				ProfilerService.end( 'update' );

				const stats = ProfilerService.getStats( 'update' );
				assert.strictEqual( stats.samples, 1, 'one inclusive sample' );
				assert.strictEqual( stats.avg, 3, 'outer scope' );

			} );

			QUnit.test( 'a trace name labels the slice while stats aggregate under the label', assert => {

				ProfilerService.begin( 'draw', 'draw (Tree - Bark)' );
				clock.advance( 2 );
				ProfilerService.end( 'draw' );
				ProfilerService.begin( 'draw', 'draw (Rock - Stone)' );
				clock.advance( 4 );
				ProfilerService.end( 'draw' );

				const stats = ProfilerService.getStats( 'draw' );
				assert.strictEqual( stats.samples, 2, 'both calls share one stats record' );
				assert.strictEqual( stats.avg, 3, 'average over both calls' );
				assert.strictEqual( ProfilerService.getStats( 'draw (Tree - Bark)' ), null, 'trace names are not stats keys' );
				assert.deepEqual(
					sliceEvents().map( event => event.name ),
					[ 'draw (Tree - Bark)', 'draw (Rock - Stone)' ],
					'each slice keeps its own name'
				);

			} );

			QUnit.test( 'recursive trace names pair with their own begin()', assert => {

				ProfilerService.begin( 'visit', 'visit (root)' );
				clock.advance( 1 );
				ProfilerService.begin( 'visit', 'visit (child)' );
				clock.advance( 1 );
				ProfilerService.end( 'visit' );
				clock.advance( 1 );
				ProfilerService.end( 'visit' );

				const slices = sliceEvents();
				assert.strictEqual( slices.find( event => event.name === 'visit (root)' ).dur, 3000, 'outer slice' );
				assert.strictEqual( slices.find( event => event.name === 'visit (child)' ).dur, 1000, 'inner slice' );

			} );

			QUnit.test( 'a scope without a trace name uses its label in the trace', assert => {

				ProfilerService.begin( 'plain', 'plain (named)' );
				ProfilerService.begin( 'plain' );
				clock.advance( 1 );
				ProfilerService.end( 'plain' );
				clock.advance( 1 );
				ProfilerService.end( 'plain' );

				assert.deepEqual(
					sliceEvents().map( event => event.name ).sort(),
					[ 'plain', 'plain (named)' ],
					'unnamed inner call falls back to the label'
				);

			} );

			QUnit.test( 'a scope ending after its parent goes to the async row', assert => {

				const tick = ProfilerService.beginSpan( 'tick' );
				clock.advance( 1 );
				ProfilerService.begin( 'load' );
				clock.advance( 2 );
				ProfilerService.endSpan( tick );
				clock.advance( 4 );
				ProfilerService.end( 'load' );

				const load = ProfilerService.getStats( 'load' );
				assert.strictEqual( load.avg, 6, 'inclusive time is still measured' );
				assert.strictEqual( load.selfAvg, undefined, 'no self time once it outlived its parent' );

				const events = ProfilerService.exportChromeTrace().traceEvents;
				assert.deepEqual( findPartialOverlaps( events ), [], 'trace slices nest' );
				const slice = events.find( event => event.name === 'load (out of order)' );
				assert.ok( slice, 'slice named as out of order' );
				assert.strictEqual( slice.tid, 2, 'async row' );

			} );

			QUnit.test( 'computes self time by subtracting child scopes', assert => {

				ProfilerService.begin( 'outer' );
				clock.advance( 1 );
				recordScope( 'inner', 3 );
				clock.advance( 2 );
				ProfilerService.end( 'outer' );

				const outer = ProfilerService.getStats( 'outer' );
				assert.strictEqual( outer.avg, 6, 'outer inclusive time' );
				assert.strictEqual( outer.selfAvg, 3, 'outer self time' );
				assert.strictEqual( ProfilerService.getStats( 'inner' ).selfAvg, 3, 'leaf self time equals inclusive time' );

			} );

			QUnit.test( 'keeps the most recent 120 samples while counting every invocation', assert => {

				for ( let i = 0; i < 130; i ++ ) recordScope( 'ring', i < 10 ? 100 : 1 );

				const stats = ProfilerService.getStats( 'ring' );
				assert.strictEqual( stats.samples, 120, 'ring buffer capacity' );
				assert.strictEqual( stats.totalInvocations, 130, 'invocations are uncapped' );
				assert.strictEqual( stats.max, 1, 'oldest samples were evicted' );

			} );

			QUnit.test( 'a synchronous span nested in a scope keeps the parent self time', assert => {

				ProfilerService.begin( 'outer' );
				clock.advance( 1 );
				const span = ProfilerService.beginSpan( 'inner-span' );
				clock.advance( 2 );
				ProfilerService.endSpan( span );
				clock.advance( 1 );
				ProfilerService.end( 'outer' );

				assert.strictEqual( ProfilerService.getStats( 'outer' ).selfAvg, 2, 'outer self time = 4 ms - 2 ms span' );

			} );

			QUnit.test( 'an async-timeline span ending mid-scope keeps open scopes intact', assert => {

				const asyncSpan = ProfilerService.beginSpan( 'load' );
				ProfilerService.begin( 'frame' );
				clock.advance( 1 );
				ProfilerService.begin( 'child' );
				clock.advance( 1 );
				ProfilerService.endSpan( asyncSpan, { asyncTimeline: true } );
				clock.advance( 1 );
				ProfilerService.end( 'child' );
				clock.advance( 1 );
				ProfilerService.end( 'frame' );

				assert.strictEqual( ProfilerService.getStats( 'child' ).selfAvg, 2, 'child self time recorded' );
				assert.strictEqual( ProfilerService.getStats( 'frame' ).selfAvg, 2, 'frame self time = 4 ms - 2 ms child' );

			} );

			QUnit.test( 'spans record self time and count towards their parents', assert => {

				const span = ProfilerService.beginSpan( 'tick' );
				clock.advance( 1 );
				recordScope( 'work', 3 );
				clock.advance( 1 );
				ProfilerService.endSpan( span );

				assert.strictEqual( ProfilerService.getStats( 'tick' ).selfAvg, 2, 'tick self time = 5 ms - 3 ms work' );

			} );

			QUnit.test( 'an unbalanced inner scope does not discard the outer self time', assert => {

				ProfilerService.begin( 'frame' );
				clock.advance( 1 );
				ProfilerService.begin( 'leaked' );
				clock.advance( 1 );
				recordScope( 'leaf', 1 );
				clock.advance( 1 );
				ProfilerService.end( 'frame' );

				assert.notStrictEqual( ProfilerService.getStats( 'frame' ).selfAvg, undefined, 'frame still has a self-time sample' );

			} );

		} );

		QUnit.module( 'spans', innerHooks => {

			innerHooks.beforeEach( () => ProfilerService.enable() );

			QUnit.test( 'tracks overlapping spans with the same label independently', assert => {

				const a = ProfilerService.beginSpan( 'fetch' );
				clock.advance( 1 );
				const b = ProfilerService.beginSpan( 'fetch' );
				clock.advance( 2 );
				ProfilerService.endSpan( a );
				clock.advance( 4 );
				ProfilerService.endSpan( b );

				const stats = ProfilerService.getStats( 'fetch' );
				assert.strictEqual( stats.samples, 2, 'both spans recorded' );
				assert.strictEqual( stats.min, 3, 'first span' );
				assert.strictEqual( stats.max, 6, 'second span' );

			} );

			QUnit.test( 'a span ending before a span started inside it keeps every self time', assert => {

				const frame = ProfilerService.beginSpan( 'frame' );
				const a = ProfilerService.beginSpan( 'fetch' );
				clock.advance( 1 );
				const b = ProfilerService.beginSpan( 'fetch' );
				clock.advance( 2 );
				ProfilerService.endSpan( a );
				clock.advance( 4 );
				ProfilerService.endSpan( b );
				clock.advance( 1 );
				ProfilerService.endSpan( frame );

				const fetch = ProfilerService.getStats( 'fetch' );
				assert.strictEqual( fetch.samples, 2, 'neither span is a recursive call of the other' );
				assert.strictEqual( fetch.selfMin, 1, 'first span: time before the second one started' );
				assert.strictEqual( fetch.selfMax, 6, 'second span keeps its frame' );
				assert.strictEqual( ProfilerService.getStats( 'frame' ).selfAvg, 1, 'frame excludes the 7 ms both fetches cover' );

			} );

			QUnit.test( 'a span ending before a span started inside it goes to the async row', assert => {

				const frame = ProfilerService.beginSpan( 'frame' );
				const a = ProfilerService.beginSpan( 'fetch' );
				clock.advance( 1 );
				const b = ProfilerService.beginSpan( 'fetch' );
				clock.advance( 2 );
				ProfilerService.endSpan( a );
				clock.advance( 4 );
				ProfilerService.endSpan( b );
				clock.advance( 1 );
				ProfilerService.endSpan( frame );

				const events = ProfilerService.exportChromeTrace().traceEvents;
				assert.deepEqual( findPartialOverlaps( events ), [], 'trace slices nest' );
				const rows = events
					.filter( event => event.ph === 'X' )
					.map( event => `${event.name}@${event.tid}` );
				assert.deepEqual(
					rows.sort(),
					[ 'fetch (out of order)@2', 'fetch@1', 'frame@1' ],
					'only the span that ended out of order leaves the main row'
				);

			} );

			QUnit.test( 'ignores a no-op handle obtained while disabled', assert => {

				ProfilerService.disable();
				const handle = ProfilerService.beginSpan( 'early' );
				ProfilerService.enable();
				ProfilerService.endSpan( handle );

				assert.strictEqual( ProfilerService.getStats( 'early' ), null, 'no sample' );

			} );

			QUnit.test( 'asyncTimeline spans use the async lane', assert => {

				const span = ProfilerService.beginSpan( 'download' );
				clock.advance( 5 );
				ProfilerService.endSpan( span, { asyncTimeline: true } );

				const [ event ] = sliceEvents();
				assert.strictEqual( event.name, 'download (promise)', 'promise suffix' );
				assert.strictEqual( event.tid, 2, 'async lane' );
				assert.strictEqual( ProfilerService.getStats( 'download' ).avg, 5, 'stats use the plain label' );

			} );

			QUnit.test( 'a span started before reset() is not committed afterwards', assert => {

				const span = ProfilerService.beginSpan( 'stale-span' );
				clock.advance( 1 );
				ProfilerService.reset();
				clock.advance( 1 );
				ProfilerService.endSpan( span );

				assert.strictEqual( ProfilerService.getStats( 'stale-span' ), null, 'stale span dropped' );

			} );

		} );

		QUnit.module( 'statistics', innerHooks => {

			innerHooks.beforeEach( () => ProfilerService.enable() );

			QUnit.test( 'getStats() returns null for unknown labels', assert => {

				assert.strictEqual( ProfilerService.getStats( 'unknown' ), null, 'null' );
				assert.deepEqual( ProfilerService.getValidSamples( 'unknown' ), [], 'no samples' );

			} );

			QUnit.test( 'computes avg / min / max / p95 / frame budget', assert => {

				for ( let ms = 1; ms <= 20; ms ++ ) recordScope( 'dist', ms );

				const stats = ProfilerService.getStats( 'dist' );
				assert.strictEqual( stats.label, 'dist', 'label' );
				assert.strictEqual( stats.samples, 20, 'samples' );
				assert.strictEqual( stats.avg, 10.5, 'avg' );
				assert.strictEqual( stats.min, 1, 'min' );
				assert.strictEqual( stats.max, 20, 'max' );
				assert.strictEqual( stats.p95, 19, 'nearest-rank p95' );
				assertClose( assert, stats.frameBudget, 63, 'frame budget is a percentage of 16.67 ms', 1e-6 );
				assertClose( assert, stats.selfFrameBudget, 63, 'self frame budget', 1e-6 );

			} );

			QUnit.test( 'frame budget follows frameBudgetMs', assert => {

				const originalBudget = ProfilerService.frameBudgetMs;
				ProfilerService.frameBudgetMs = 10;
				try {

					recordScope( 'budget', 5 );
					assert.strictEqual( ProfilerService.getStats( 'budget' ).frameBudget, 50, '5 ms of a 10 ms budget' );

				} finally {

					ProfilerService.frameBudgetMs = originalBudget;

				}

			} );

			QUnit.test( 'self-time stats cover the same calls as inclusive stats', assert => {

				const sync = ProfilerService.beginSpan( 'mixed' );
				clock.advance( 2 );
				ProfilerService.endSpan( sync );
				const async = ProfilerService.beginSpan( 'mixed', { asyncTimeline: true } );
				clock.advance( 4 );
				ProfilerService.endSpan( async, { asyncTimeline: true } );

				const stats = ProfilerService.getStats( 'mixed' );
				assert.strictEqual( stats.samples, 2, 'both calls in the inclusive window' );
				assert.strictEqual( stats.selfAvg, 2, 'async call has no self time and is skipped' );

			} );

			QUnit.test( 'getValidSamples() returns a copy of the recorded samples', assert => {

				recordScope( 'copy', 1 );
				recordScope( 'copy', 2 );

				const samples = ProfilerService.getValidSamples( 'copy' );
				assert.deepEqual( samples, [ 1, 2 ], 'samples in recording order' );
				samples[ 0 ] = 99;
				assert.deepEqual( ProfilerService.getValidSamples( 'copy' ), [ 1, 2 ], 'internal buffer untouched' );

			} );

			QUnit.test( 'getAllStats() and exportJSON() list every label', assert => {

				recordScope( 'a', 1 );
				recordScope( 'b', 1 );

				assert.deepEqual( ProfilerService.getAllStats().map( stats => stats.label ).sort(), [ 'a', 'b' ], 'getAllStats' );
				assert.deepEqual( ProfilerService.exportJSON(), ProfilerService.getAllStats(), 'exportJSON mirrors getAllStats' );

			} );

		} );

		QUnit.module( 'report', innerHooks => {

			innerHooks.beforeEach( () => ProfilerService.enable() );

			QUnit.test( 'logs a hint when there is no data', assert => {

				const log = captureConsole( 'log' );
				const table = captureConsole( 'table' );
				try {

					ProfilerService.report();

				} finally {

					log.restore();
					table.restore();

				}

				assert.true( log.calls.some( args => String( args[ 0 ] ).includes( 'No data' ) ), 'hint logged' );
				assert.strictEqual( table.calls.length, 0, 'no table printed' );

			} );

			QUnit.test( 'prints CPU timings sorted by average cost', assert => {

				recordScope( 'cheap', 1 );
				recordScope( 'expensive', 3 );

				const table = captureConsole( 'table' );
				try {

					ProfilerService.report();

				} finally {

					table.restore();

				}

				const rows = table.calls[ 0 ][ 0 ];
				assert.deepEqual( rows.map( row => row.label ), [ 'expensive', 'cheap' ], 'sorted by avg descending' );
				assert.strictEqual( rows[ 0 ][ 'avg ms' ], '3.000', 'formatted avg' );
				assert.strictEqual( rows[ 0 ][ 'budget %' ], '18.0%', 'formatted budget' );
				assert.strictEqual( rows[ 0 ].samples, 1, 'sample count' );
				assert.strictEqual( rows[ 0 ][ 'self avg ms' ], '3.000', 'self time column' );
				assert.strictEqual( rows[ 0 ].calls, 1, 'call count column' );

			} );

		} );

		QUnit.module( 'Chrome trace export', innerHooks => {

			innerHooks.beforeEach( () => ProfilerService.enable() );

			QUnit.test( 'emits microsecond slices relative to enable() on the main thread', assert => {

				clock.advance( 2.5 );
				recordScope( 'slice', 1.25 );

				const [ event ] = sliceEvents();
				assert.deepEqual(
					{ name: event.name, ph: event.ph, ts: event.ts, dur: event.dur, pid: event.pid, tid: event.tid, cat: event.cat },
					{ name: 'slice', ph: 'X', ts: 2500, dur: 1250, pid: 1, tid: 1, cat: 'gnsx' },
					'complete event'
				);

			} );

			QUnit.test( 'omits zero-length scopes from the trace but keeps their stats', assert => {

				ProfilerService.begin( 'parent' );
				clock.advance( 1 );
				recordScope( 'instant', 0 );
				recordScope( 'sub-microsecond', 0.0004 );
				ProfilerService.end( 'parent' );

				assert.deepEqual( sliceEvents().map( event => event.name ), [ 'parent' ], 'only the parent is traced' );
				assert.strictEqual( ProfilerService.getStats( 'instant' ).samples, 1, 'zero-length call still counted' );
				assert.strictEqual( ProfilerService.getStats( 'sub-microsecond' ).samples, 1, 'sub-µs call still counted' );

			} );

			QUnit.test( 'only declares async and GPU lanes that contain events', assert => {

				recordScope( 'sync', 1 );
				let metadata = ProfilerService.exportChromeTrace().traceEvents.filter( event => event.ph === 'M' );
				assert.deepEqual(
					metadata.map( event => `${event.name}:${event.tid}:${event.args.name}` ),
					[ 'process_name:0:Genesys Profiler', 'thread_name:1:Main thread' ],
					'process and main thread only'
				);

				const span = ProfilerService.beginSpan( 'promise' );
				clock.advance( 1 );
				ProfilerService.endSpan( span, { asyncTimeline: true } );
				metadata = ProfilerService.exportChromeTrace().traceEvents.filter( event => event.ph === 'M' );
				assert.true( metadata.some( event => event.tid === 2 ), 'async lane declared once used' );
				assert.false( metadata.some( event => event.tid === 3 ), 'GPU lane still absent' );

			} );

			QUnit.test( 'filters short slices without touching captured data', assert => {

				recordScope( 'short', 0.01 );
				recordScope( 'long', 1 );

				assert.deepEqual(
					ProfilerService.exportChromeTrace( 0.05 ).traceEvents.filter( event => event.ph === 'X' ).map( event => event.name ),
					[ 'long' ],
					'short slice omitted'
				);
				assert.strictEqual( ProfilerService.traceEvents.length, 2, 'capture keeps every slice' );

				for ( const threshold of [ NaN, - 1, Infinity ] ) {

					assert.strictEqual(
						ProfilerService.exportChromeTrace( threshold ).traceEvents.filter( event => event.ph === 'X' ).length,
						2,
						`threshold ${threshold} is ignored`
					);

				}

			} );

			QUnit.test( 'orders slices by start time', assert => {

				ProfilerService.begin( 'outer' );
				clock.advance( 1 );
				recordScope( 'inner', 1 );
				clock.advance( 1 );
				ProfilerService.end( 'outer' );

				assert.deepEqual( sliceEvents().map( event => event.name ), [ 'outer', 'inner' ], 'outer starts first' );

			} );

			QUnit.test( 'stats profile does not record CPU trace events', assert => {

				ProfilerService.setProfile( 'stats' );
				ProfilerService.enable();
				recordScope( 'stats-only', 1 );

				assert.ok( ProfilerService.getStats( 'stats-only' ), 'stats still collected' );
				assert.strictEqual( ProfilerService.traceEvents.length, 0, 'no trace events retained' );

			} );

			QUnit.test( 'stops recording trace events at maxTraceEvents', assert => {

				const originalLimit = ProfilerService.maxTraceEvents;
				ProfilerService.maxTraceEvents = 2;
				try {

					for ( let i = 0; i < 5; i ++ ) recordScope( 'capped', 1 );

				} finally {

					ProfilerService.maxTraceEvents = originalLimit;

				}

				assert.strictEqual( ProfilerService.traceEvents.length, 2, 'trace capped' );
				assert.strictEqual( ProfilerService.getStats( 'capped' ).samples, 5, 'stats unaffected by the cap' );

			} );

			QUnit.test( 'orders a parent before a child that starts on the same microsecond', assert => {

				ProfilerService.begin( 'zz-parent' );
				ProfilerService.begin( 'aa-child' );
				clock.advance( 1 );
				ProfilerService.end( 'aa-child' );
				clock.advance( 1 );
				ProfilerService.end( 'zz-parent' );

				assert.deepEqual( sliceEvents().map( event => event.name ), [ 'zz-parent', 'aa-child' ], 'longer slice first' );

			} );

			QUnit.test( 'keeps child slices inside their parent after µs rounding', assert => {

				clock.set( 1000.0004 );
				ProfilerService.begin( 'parent' );
				clock.set( 1000.5006 );
				ProfilerService.begin( 'child' );
				clock.set( 1001.0004 );
				ProfilerService.end( 'child' );
				ProfilerService.end( 'parent' );

				const parent = sliceEvents().find( event => event.name === 'parent' );
				const child = sliceEvents().find( event => event.name === 'child' );
				assert.true( child.ts >= parent.ts, 'child starts inside parent' );
				assert.true(
					child.ts + child.dur <= parent.ts + parent.dur,
					`child ends (${child.ts + child.dur}) inside parent (${parent.ts + parent.dur})`
				);

			} );

			QUnit.test( 'lists parents first when nested slices cover the same rounded range', assert => {

				// A coarse performance.now() (100 µs without cross-origin isolation) often gives
				// nested scopes identical start and end times.
				ProfilerService.begin( '_renderScene' );
				ProfilerService.begin( '_renderObjects' );
				ProfilerService.begin( 'renderObject' );
				clock.advance( 1 );
				ProfilerService.end( 'renderObject' );
				ProfilerService.end( '_renderObjects' );
				ProfilerService.end( '_renderScene' );

				assert.deepEqual(
					sliceEvents().map( event => event.name ),
					[ '_renderScene', '_renderObjects', 'renderObject' ],
					'trace viewers nest equal slices in file order'
				);

			} );

			QUnit.test( 'async promise slices never partially overlap on a thread', assert => {

				const a = ProfilerService.beginSpan( 'request' );
				clock.advance( 5 );
				const b = ProfilerService.beginSpan( 'request' );
				clock.advance( 5 );
				ProfilerService.endSpan( a, { asyncTimeline: true } );
				clock.advance( 5 );
				ProfilerService.endSpan( b, { asyncTimeline: true } );

				assert.deepEqual( findPartialOverlaps( ProfilerService.exportChromeTrace().traceEvents ), [], 'trace slices nest' );

			} );

			QUnit.test( 'nested promise lifetimes share one async row', assert => {

				const outer = ProfilerService.beginSpan( 'outer-request', { asyncTimeline: true } );
				clock.advance( 1 );
				const inner = ProfilerService.beginSpan( 'inner-request', { asyncTimeline: true } );
				clock.advance( 1 );
				ProfilerService.endSpan( inner, { asyncTimeline: true } );
				clock.advance( 1 );
				ProfilerService.endSpan( outer, { asyncTimeline: true } );

				const tids = sliceEvents().map( event => event.tid );
				assert.deepEqual( tids, [ 2, 2 ], 'inner nests under outer on tid 2' );

			} );

			QUnit.test( 'overlapping promise lifetimes get their own declared rows', assert => {

				const a = ProfilerService.beginSpan( 'request', { asyncTimeline: true } );
				clock.advance( 5 );
				const b = ProfilerService.beginSpan( 'request', { asyncTimeline: true } );
				clock.advance( 5 );
				ProfilerService.endSpan( a, { asyncTimeline: true } );
				clock.advance( 5 );
				ProfilerService.endSpan( b, { asyncTimeline: true } );

				const trace = ProfilerService.exportChromeTrace();
				const rows = trace.traceEvents.filter( event => event.ph === 'X' ).map( event => event.tid );
				const declared = trace.traceEvents.filter( event => event.ph === 'M' ).map( event => event.tid );
				assert.strictEqual( new Set( rows ).size, 2, 'two rows' );
				assert.true( rows.every( tid => declared.includes( tid ) ), 'every row has a thread_name' );
				assert.true( ProfilerService.traceEvents.every( event => event.tid === 2 ), 'captured events untouched' );

			} );

		} );

		QUnit.module( 'downloadTrace', innerHooks => {

			let originalCreateObjectURL;
			let originalRevokeObjectURL;
			let originalClick;
			let downloads;
			let blobs;

			innerHooks.beforeEach( () => {

				ProfilerService.enable();

				downloads = [];
				blobs = [];
				originalCreateObjectURL = URL.createObjectURL;
				originalRevokeObjectURL = URL.revokeObjectURL;
				originalClick = HTMLAnchorElement.prototype.click;
				URL.createObjectURL = blob => {

					blobs.push( blob );
					return 'blob:profiler-test';

				};

				URL.revokeObjectURL = () => {};

				HTMLAnchorElement.prototype.click = function () {

					downloads.push( { href: this.href, download: this.download } );

				};

			} );

			innerHooks.afterEach( () => {

				URL.createObjectURL = originalCreateObjectURL;
				URL.revokeObjectURL = originalRevokeObjectURL;
				HTMLAnchorElement.prototype.click = originalClick;

			} );

			QUnit.test( 'refuses to download in the stats profile', assert => {

				ProfilerService.setProfile( 'stats' );
				recordScope( 'stats-scope', 1 );
				ProfilerService.downloadTrace();

				assert.strictEqual( downloads.length, 0, 'no download' );

			} );

			QUnit.test( 'does nothing when there are no trace events', assert => {

				ProfilerService.downloadTrace();
				assert.strictEqual( downloads.length, 0, 'no download' );

			} );

			QUnit.test( 'downloads the filtered trace as JSON', async assert => {

				recordScope( 'kept', 1 );
				recordScope( 'dropped', 0.01 );

				const log = captureConsole( 'log' );
				try {

					ProfilerService.downloadTrace( 'trace.json', 0.05 );

				} finally {

					log.restore();

				}

				assert.deepEqual( downloads, [ { href: 'blob:profiler-test', download: 'trace.json' } ], 'one download' );
				const trace = JSON.parse( await blobs[ 0 ].text() );
				assert.deepEqual(
					trace.traceEvents.filter( event => event.ph === 'X' ).map( event => event.name ),
					[ 'kept' ],
					'filtered slices'
				);
				assert.true( log.calls.some( args => String( args[ 0 ] ).includes( 'filtered 1 spans' ) ), 'filter summary logged' );

			} );

		} );

		QUnit.module( 'User Timing', () => {

			QUnit.test( 'names scope measures after the trace name', assert => {

				ProfilerService.enable();
				ProfilerService.begin( 'ut-named', 'ut-named (Tree - Bark)' );
				clock.advance( 1 );
				ProfilerService.end( 'ut-named' );

				assert.strictEqual( performance.getEntriesByName( 'gnsx:ut-named (Tree - Bark)', 'measure' ).length, 1, 'measure uses the trace name' );
				assert.strictEqual( performance.getEntriesByName( 'gnsx:ut-named', 'measure' ).length, 0, 'not the stats label' );

			} );

			QUnit.test( 'mirrors scopes and spans as gnsx measures', assert => {

				ProfilerService.enable();
				const before = performance.getEntriesByName( 'gnsx:ut-scope', 'measure' ).length;
				recordScope( 'ut-scope', 1 );
				const span = ProfilerService.beginSpan( 'ut-span' );
				ProfilerService.endSpan( span );

				assert.strictEqual( performance.getEntriesByName( 'gnsx:ut-scope', 'measure' ).length, before + 1, 'scope measure' );
				assert.true(
					performance.getEntriesByType( 'measure' ).some( entry => entry.name === `gnsx:ut-span#${span._seq}` ),
					'span measure'
				);

			} );

			QUnit.test( 'stats profile creates no User Timing entries', assert => {

				ProfilerService.setProfile( 'stats' );
				ProfilerService.enable();
				const before = countGnsxUserTimingEntries();
				recordScope( 'ut-stats', 1 );
				ProfilerService.endSpan( ProfilerService.beginSpan( 'ut-stats-span' ) );

				assert.strictEqual( countGnsxUserTimingEntries() - before, 0, 'no marks or measures added' );

			} );

			QUnit.test( 'disable() removes the User Timing entries it created', assert => {

				ProfilerService.enable();
				recordScope( 'ut-cleanup', 1 );
				ProfilerService.disable();

				assert.strictEqual( countGnsxUserTimingEntries(), 0, 'no gnsx marks or measures left behind' );

			} );

			QUnit.test( 'end() survives marks cleared by other code', assert => {

				ProfilerService.enable();
				ProfilerService.begin( 'ut-cleared' );
				clock.advance( 1 );
				clearGnsxMarks();

				try {

					ProfilerService.end( 'ut-cleared' );
					assert.ok( ProfilerService.getStats( 'ut-cleared' ), 'sample recorded' );

				} catch ( error ) {

					assert.ok( false, `end() threw: ${error.message}` );

				}

			} );

			QUnit.test( 'endSpan() survives marks cleared by other code', assert => {

				ProfilerService.enable();
				const span = ProfilerService.beginSpan( 'ut-span-cleared' );
				clock.advance( 1 );
				clearGnsxMarks();

				try {

					ProfilerService.endSpan( span );
					assert.ok( ProfilerService.getStats( 'ut-span-cleared' ), 'sample recorded' );

				} catch ( error ) {

					assert.ok( false, `endSpan() threw: ${error.message}` );

				}

			} );

		} );

	} );

} );
// !WITH_GENESYS
