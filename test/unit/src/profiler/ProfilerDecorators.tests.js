// WITH_GENESYS
import { ProfilerService, profile, profileClass } from 'three';
import { CONSOLE_LEVEL } from '../../utils/console-wrapper.js';
import { installFakeClock, useRealPerformance } from './ProfilerTestUtils.js';

/**
 * Applies a legacy (TypeScript `experimentalDecorators`) method decorator by hand.
 *
 * @param {function(Object, string, PropertyDescriptor): PropertyDescriptor} decorator
 * @param {Object} target Prototype for instance methods, constructor for static methods.
 * @param {string} key
 */
function decorate( decorator, target, key ) {

	const descriptor = Object.getOwnPropertyDescriptor( target, key );
	Object.defineProperty( target, key, decorator( target, key, descriptor ) );

}

export default QUnit.module( 'Profiler', () => {

	QUnit.module( 'decorators', hooks => {

		let clock;
		let restorePerformance;

		function createWorkerClass() {

			class Worker {

				constructor() {

					this.calls = 0;

				}

				add( a, b ) {

					this.calls ++;
					clock.advance( 2 );
					return a + b;

				}

				fail() {

					clock.advance( 1 );
					throw new Error( 'boom' );

				}

				async load( value ) {

					clock.advance( 3 );
					return value;

				}

				async reject() {

					throw new Error( 'nope' );

				}

			}

			return Worker;

		}

		hooks.beforeEach( () => {

			console.level = CONSOLE_LEVEL.ERROR;
			restorePerformance = useRealPerformance();
			clock = installFakeClock( 1000 );
			ProfilerService.setProfile( 'full' );
			ProfilerService.enable();

		} );

		hooks.afterEach( () => {

			ProfilerService.disable();
			clock.restore();
			restorePerformance();
			console.level = CONSOLE_LEVEL.DEFAULT;

		} );

		QUnit.test( '@profile labels samples ClassName.method and preserves the call', assert => {

			const Worker = createWorkerClass();
			decorate( profile, Worker.prototype, 'add' );

			const worker = new Worker();
			assert.strictEqual( worker.add( 2, 3 ), 5, 'return value and arguments preserved' );
			assert.strictEqual( worker.calls, 1, 'this preserved' );

			const stats = ProfilerService.getStats( 'Worker.add' );
			assert.strictEqual( stats.samples, 1, 'one sample' );
			assert.strictEqual( stats.avg, 2, 'measured duration' );

		} );

		QUnit.test( '@profile( tag ) uses the custom label', assert => {

			const Worker = createWorkerClass();
			decorate( profile( 'Custom tag' ), Worker.prototype, 'add' );

			new Worker().add( 1, 1 );

			assert.ok( ProfilerService.getStats( 'Custom tag' ), 'custom label' );
			assert.strictEqual( ProfilerService.getStats( 'Worker.add' ), null, 'default label unused' );

		} );

		QUnit.test( '@profile() without arguments returns the default decorator', assert => {

			const Worker = createWorkerClass();
			decorate( profile(), Worker.prototype, 'add' );

			new Worker().add( 1, 1 );

			assert.ok( ProfilerService.getStats( 'Worker.add' ), 'default label' );

		} );

		QUnit.test( '@profile rethrows synchronous errors and still records the call', assert => {

			const Worker = createWorkerClass();
			decorate( profile, Worker.prototype, 'fail' );

			assert.throws( () => new Worker().fail(), /boom/, 'error propagates' );
			assert.strictEqual( ProfilerService.getStats( 'Worker.fail' ).avg, 1, 'sample recorded' );

		} );

		QUnit.test( '@profile on async methods records the promise lifetime on the async lane', async assert => {

			const Worker = createWorkerClass();
			decorate( profile, Worker.prototype, 'load' );

			assert.strictEqual( await new Worker().load( 'value' ), 'value', 'resolved value preserved' );

			const event = ProfilerService.exportChromeTrace().traceEvents.find( entry => entry.name === 'Worker.load (promise)' );
			assert.ok( event, 'promise slice exported' );
			assert.strictEqual( event.tid, 2, 'async lane' );
			assert.strictEqual( ProfilerService.getStats( 'Worker.load' ).avg, 3, 'stats use the method label' );

		} );

		QUnit.test( '@profile on async methods does not adopt sibling scopes', async assert => {

			const Worker = createWorkerClass();
			decorate( profile, Worker.prototype, 'load' );

			ProfilerService.begin( 'frame' );
			const pending = new Worker().load( 1 );
			ProfilerService.begin( 'sibling' );
			clock.advance( 2 );
			ProfilerService.end( 'sibling' );
			ProfilerService.end( 'frame' );
			await pending;

			assert.strictEqual( ProfilerService.getStats( 'frame' ).selfAvg, 3, 'frame self time = 5 ms - 2 ms sibling' );

		} );

		QUnit.test( '@profile on async methods propagates rejections and records the call', async assert => {

			const Worker = createWorkerClass();
			decorate( profile, Worker.prototype, 'reject' );

			await assert.rejects( new Worker().reject(), /nope/, 'rejection propagates' );
			assert.ok( ProfilerService.getStats( 'Worker.reject' ), 'sample recorded' );

		} );

		QUnit.test( '@profile records nothing while disabled', assert => {

			const Worker = createWorkerClass();
			decorate( profile, Worker.prototype, 'add' );
			ProfilerService.disable();

			assert.strictEqual( new Worker().add( 2, 2 ), 4, 'method still runs' );
			assert.deepEqual( ProfilerService.getAllStats(), [], 'no samples' );

		} );

		QUnit.test( 'profileClass() wraps every prototype method', assert => {

			class Service {

				constructor() {

					this.value = 1;

				}

				get doubled() {

					return this.value * 2;

				}

				ping() {

					clock.advance( 1 );
					return 'pong';

				}

			}

			assert.strictEqual( profileClass( Service ), Service, 'returns the class' );

			const service = new Service();
			assert.strictEqual( service.ping(), 'pong', 'method still works' );
			assert.strictEqual( service.doubled, 2, 'accessor still works' );
			assert.strictEqual( Service.prototype.constructor, Service, 'constructor untouched' );
			assert.ok( ProfilerService.getStats( 'Service.ping' ), 'method profiled' );
			assert.strictEqual( ProfilerService.getStats( 'Service.doubled' ), null, 'accessor not profiled' );

		} );

		QUnit.test( 'profileClass() does not re-wrap @profile methods', assert => {

			const Worker = createWorkerClass();
			decorate( profile( 'Custom tag' ), Worker.prototype, 'add' );
			profileClass( Worker );

			new Worker().add( 1, 1 );

			assert.strictEqual( ProfilerService.getStats( 'Custom tag' ).samples, 1, 'decorated label kept' );
			assert.strictEqual( ProfilerService.getStats( 'Worker.add' ), null, 'no second wrapper' );

		} );

		QUnit.test( '@profile keeps the method name', assert => {

			const Worker = createWorkerClass();
			decorate( profile, Worker.prototype, 'add' );

			assert.strictEqual( Worker.prototype.add.name, 'add', 'wrapper is named after the method' );

		} );

		QUnit.test( '@profile on static methods uses the class name', assert => {

			class Factory {

				static make() {

					clock.advance( 1 );
					return 1;

				}

			}

			decorate( profile, Factory, 'make' );
			Factory.make();

			assert.ok( ProfilerService.getStats( 'Factory.make' ), `labelled Factory.make (got ${ProfilerService.getAllStats().map( stats => stats.label )})` );

		} );

		QUnit.test( '@profile returns the original promise while disabled', assert => {

			class Cache {

				constructor( pending ) {

					this.pending = pending;

				}

				get() {

					return this.pending;

				}

			}

			decorate( profile, Cache.prototype, 'get' );
			ProfilerService.disable();

			const pending = Promise.resolve( 1 );
			assert.strictEqual( new Cache( pending ).get(), pending, 'promise identity preserved' );

		} );

	} );

} );
// !WITH_GENESYS
