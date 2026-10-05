// WITH_GENESYS
import Backend from '../../../../src/renderers/common/Backend.js';
import WebGPUBackend from '../../../../src/renderers/webgpu/WebGPUBackend.js';
import WebGPUTexturePassUtils from '../../../../src/renderers/webgpu/utils/WebGPUTexturePassUtils.js';

/**
 * `this` for `WebGPUBackend.prototype.allocateTimestampQuery` with a fake render pool.
 *
 * @param {Object} [options]
 * @param {boolean} [options.trackTimestamp=true]
 * @param {?number} [options.baseOffset=4] Offset the pool allocates, or `null` when it is full.
 */
function createTimestampBackend( { trackTimestamp = true, baseOffset = 4 } = {} ) {

	const querySet = { label: 'querySet' };
	const notified = [];

	return {
		querySet,
		notified,
		trackTimestamp,
		timestampQueryPool: {
			render: {
				querySet,
				allocated: [],
				allocateQueriesForContext( uid ) {

					this.allocated.push( uid );
					return baseOffset;

				},
			},
		},
		notifyTimestampQuery( type, uid, label ) {

			notified.push( { type, uid, label } );

		},
	};

}

/**
 * @return {{ encoder: Object, descriptors: Object[] }} A command encoder that records the descriptor of every pass it begins.
 */
function createRecordingEncoder() {

	const descriptors = [];
	const encoder = {
		beginRenderPass( descriptor ) {

			descriptors.push( { timestampWrites: descriptor.timestampWrites } );
			return { executeBundles() {}, end() {} };

		},
	};

	return { encoder, descriptors };

}

/**
 * @param {number} count
 * @return {Array<Object>} Mipmap passes as cached by `_mipmapCreateBundles()`.
 */
function createMipmapPasses( count ) {

	return Array.from( { length: count }, () => ( { renderBundles: [], passDescriptor: { colorAttachments: [], timestampWrites: undefined } } ) );

}

export default QUnit.module( 'Profiler', () => {

	QUnit.module( 'GPU pass coverage', () => {

		QUnit.module( 'compute labels', () => {

			const getLabel = computeGroup => Backend.prototype.getComputeProfilerLabel.call( null, computeGroup );

			QUnit.test( 'uses the compute node name', assert => {

				assert.strictEqual( getLabel( { name: 'particles' } ), 'Compute (particles)' );

			} );

			QUnit.test( 'joins the named nodes of a compute group', assert => {

				assert.strictEqual( getLabel( [ { name: 'a' }, { name: '' }, { name: 'b' } ] ), 'Compute (a, b)' );

			} );

			QUnit.test( 'labels unnamed compute so it is not dropped', assert => {

				assert.strictEqual( getLabel( { name: '' } ), 'Compute' );
				assert.strictEqual( getLabel( [ { name: '' } ] ), 'Compute' );

			} );

		} );

		QUnit.module( 'WebGPUBackend.allocateTimestampQuery', () => {

			const allocate = ( backend, ...args ) => WebGPUBackend.prototype.allocateTimestampQuery.call( backend, ...args );

			QUnit.test( 'returns the query set and offset and reports the label', assert => {

				const backend = createTimestampBackend();

				const allocation = allocate( backend, 'render', 'm:1:7:f3', 'Mipmaps (output)' );

				assert.deepEqual( allocation, { querySet: backend.querySet, baseOffset: 4 } );
				assert.deepEqual( backend.notified, [ { type: 'render', uid: 'm:1:7:f3', label: 'Mipmaps (output)' } ] );

			} );

			QUnit.test( 'allocates nothing while timestamps are not tracked', assert => {

				const backend = createTimestampBackend( { trackTimestamp: false } );

				assert.strictEqual( allocate( backend, 'render', 'm:1:7:f3', 'Mipmaps' ), null );
				assert.deepEqual( backend.timestampQueryPool.render.allocated, [] );
				assert.deepEqual( backend.notified, [] );

			} );

			QUnit.test( 'reports nothing when the pool cannot allocate', assert => {

				const backend = createTimestampBackend( { baseOffset: null } );

				assert.strictEqual( allocate( backend, 'render', 'm:1:7:f3', 'Mipmaps' ), null );
				assert.deepEqual( backend.notified, [] );

			} );

			QUnit.test( 'initTimestampQuery writes both ends of one pass', assert => {

				const backend = createTimestampBackend();
				backend.allocateTimestampQuery = WebGPUBackend.prototype.allocateTimestampQuery;
				const descriptor = {};

				WebGPUBackend.prototype.initTimestampQuery.call( backend, 'render', 'r:0:1:f3', descriptor, 'Scene' );

				assert.deepEqual( descriptor.timestampWrites, { querySet: backend.querySet, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 } );

			} );

		} );

		QUnit.module( 'mipmap timestamps', () => {

			const run = ( encoder, passes, timestampQuery ) => WebGPUTexturePassUtils.prototype._mipmapRunBundles.call( null, encoder, passes, timestampQuery );

			QUnit.test( 'one pair spans every mipmap pass', assert => {

				const { encoder, descriptors } = createRecordingEncoder();
				const querySet = {};

				run( encoder, createMipmapPasses( 3 ), { querySet, baseOffset: 10 } );

				assert.deepEqual( descriptors.map( descriptor => descriptor.timestampWrites ), [
					{ querySet, beginningOfPassWriteIndex: 10 },
					undefined,
					{ querySet, endOfPassWriteIndex: 11 },
				] );

			} );

			QUnit.test( 'a single mipmap pass writes both ends', assert => {

				const { encoder, descriptors } = createRecordingEncoder();
				const querySet = {};

				run( encoder, createMipmapPasses( 1 ), { querySet, baseOffset: 10 } );

				assert.deepEqual( descriptors[ 0 ].timestampWrites, { querySet, beginningOfPassWriteIndex: 10, endOfPassWriteIndex: 11 } );

			} );

			QUnit.test( 'clears writes left on cached descriptors when untimed', assert => {

				const passes = createMipmapPasses( 2 );
				run( createRecordingEncoder().encoder, passes, { querySet: {}, baseOffset: 10 } );

				const { encoder, descriptors } = createRecordingEncoder();
				run( encoder, passes, null );

				assert.deepEqual( descriptors.map( descriptor => descriptor.timestampWrites ), [ undefined, undefined ] );

			} );

		} );

	} );

} );
// !WITH_GENESYS
