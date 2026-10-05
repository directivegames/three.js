// WITH_GENESYS
import Backend from '../../../../src/renderers/common/Backend.js';
import WebGPUBackend from '../../../../src/renderers/webgpu/WebGPUBackend.js';
import WebGPUTexturePassUtils from '../../../../src/renderers/webgpu/utils/WebGPUTexturePassUtils.js';
import { PassTimestampLevel } from '../../../../src/profiler/PassTimestampLevel.js';
import { CONSOLE_LEVEL } from '../../utils/console-wrapper.js';

/**
 * `this` for `WebGPUBackend.prototype.allocateTimestampQuery` with a fake render pool.
 *
 * @param {Object} [options]
 * @param {boolean} [options.trackTimestamp=true]
 * @param {?number} [options.baseOffset=4] Offset of the first allocation (later ones follow it), or `null` when the pool is full.
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
				currentQueryIndex: 0,
				maxQueries: 4096,
				allocateQueriesForContext( uid ) {

					this.allocated.push( uid );
					return baseOffset === null ? null : baseOffset + 2 * ( this.allocated.length - 1 );

				},
			},
		},
		notifyTimestampQuery( type, uid, label, parentUid ) {

			notified.push( { type, uid, label, parentUid } );

		},
	};

}

/**
 * `this` for `WebGPUBackend.prototype.beginPassTimestampSpan` with one render context in its pass.
 *
 * @param {Object} [options]
 * @param {number} [options.level=PassTimestampLevel.DRAW]
 * @param {boolean} [options.supportsPassTimestamps=true]
 * @param {?Object} [options.pass] Current pass; defaults to one that records `writeTimestamp()` indices.
 */
function createPassSpanBackend( { level = PassTimestampLevel.DRAW, supportsPassTimestamps = true, pass = createTimestampPass() } = {} ) {

	const renderContext = { id: 3 };
	const renderContextData = { currentPass: pass };

	const backend = Object.assign( createTimestampBackend(), {
		passTimestampLevel: level,
		supportsPassTimestamps,
		_passTimestampSpanCount: 0,
		renderer: { info: { frame: 7 } },
		get: () => renderContextData,
		getTimestampUID: context => `r:0:${ context.id }:f7`,
		allocateTimestampQuery: WebGPUBackend.prototype.allocateTimestampQuery,
		_closePassTimestampSpans: WebGPUBackend.prototype._closePassTimestampSpans,
	} );

	return {
		backend,
		renderContext,
		renderContextData,
		pass,
		begin: ( label, spanLevel ) => WebGPUBackend.prototype.beginPassTimestampSpan.call( backend, renderContext, label, spanLevel ),
		end: span => WebGPUBackend.prototype.endPassTimestampSpan.call( backend, span ),
	};

}

/**
 * @return {{ writes: number[], writeTimestamp: function(Object, number): void }}
 */
function createTimestampPass() {

	return {
		writes: [],
		writeTimestamp( querySet, index ) {

			this.writes.push( index );

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
				assert.deepEqual( backend.notified, [ { type: 'render', uid: 'm:1:7:f3', label: 'Mipmaps (output)', parentUid: null } ] );

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

		QUnit.module( 'in-pass timestamp spans', () => {

			QUnit.test( 'times nothing above the requested level', assert => {

				const { begin, pass, backend } = createPassSpanBackend( { level: PassTimestampLevel.STAGE } );

				assert.strictEqual( begin( 'Mesh (Basic)', PassTimestampLevel.DRAW ), null );
				assert.deepEqual( pass.writes, [] );
				assert.deepEqual( backend.notified, [] );

			} );

			QUnit.test( 'times nothing without in-pass timestamp support', assert => {

				const { begin, pass } = createPassSpanBackend( { supportsPassTimestamps: false } );

				assert.strictEqual( begin( 'Opaque', PassTimestampLevel.STAGE ), null );
				assert.deepEqual( pass.writes, [] );

			} );

			QUnit.test( 'skips encoders without writeTimestamp (render bundles)', assert => {

				const { begin, backend } = createPassSpanBackend( { pass: {} } );

				assert.strictEqual( begin( 'Opaque', PassTimestampLevel.STAGE ), null );
				assert.deepEqual( backend.notified, [] );

			} );

			QUnit.test( 'nests spans under the pass and the innermost open span', assert => {

				const { begin, end, pass, backend } = createPassSpanBackend();

				const opaque = begin( 'Opaque', PassTimestampLevel.STAGE );
				const draw = begin( 'Mesh (Basic)', PassTimestampLevel.DRAW );
				end( draw );
				end( opaque );

				assert.deepEqual( backend.notified.map( query => [ query.uid, query.label, query.parentUid ] ), [
					[ 'p:1:3:f7', 'Opaque', 'r:0:3:f7' ],
					[ 'p:2:3:f7', 'Mesh (Basic)', 'p:1:3:f7' ],
				] );
				assert.deepEqual( pass.writes, [ 4, 6, 7, 5 ], 'begin and end indices of each span, properly nested' );

			} );

			QUnit.test( 'ending a span closes the spans left open inside it', assert => {

				const { begin, end, pass, renderContextData } = createPassSpanBackend();

				const opaque = begin( 'Opaque', PassTimestampLevel.STAGE );
				const draw = begin( 'Mesh (Basic)', PassTimestampLevel.DRAW );
				end( opaque );
				end( draw );

				assert.deepEqual( pass.writes, [ 4, 6, 7, 5 ], 'inner end written first, late end ignored' );
				assert.deepEqual( renderContextData.passTimestampSpans, [] );

			} );

			QUnit.test( 'closing the pass ends every open span', assert => {

				const { begin, backend, pass, renderContextData } = createPassSpanBackend();

				begin( 'Opaque', PassTimestampLevel.STAGE );
				begin( 'Mesh (Basic)', PassTimestampLevel.DRAW );
				backend._closePassTimestampSpans( renderContextData );

				assert.deepEqual( pass.writes, [ 4, 6, 7, 5 ] );
				assert.deepEqual( renderContextData.passTimestampSpans, [] );

			} );

			QUnit.test( 'ends a span on the pass that replaced its own', assert => {

				const { begin, end, pass, renderContextData } = createPassSpanBackend();

				const opaque = begin( 'Opaque', PassTimestampLevel.STAGE );
				// A framebuffer copy ends the pass and begins a new one mid-stage.
				renderContextData.currentPass = createTimestampPass();
				end( opaque );

				assert.deepEqual( pass.writes, [ 4 ], 'begin on the first pass' );
				assert.deepEqual( renderContextData.currentPass.writes, [ 5 ], 'end on the restarted pass' );

			} );

			QUnit.test( 'stops timing draws before they fill the pool', assert => {

				const { begin, backend } = createPassSpanBackend();
				const pool = backend.timestampQueryPool.render;
				pool.currentQueryIndex = pool.maxQueries * 0.75 - 1;

				console.level = CONSOLE_LEVEL.ERROR;
				try {

					assert.strictEqual( begin( 'Mesh (Basic)', PassTimestampLevel.DRAW ), null, 'draw skipped' );

				} finally {

					console.level = CONSOLE_LEVEL.DEFAULT;

				}

				assert.notStrictEqual( begin( 'Opaque', PassTimestampLevel.STAGE ), null, 'stages still timed' );

			} );

		} );

	} );

} );
// !WITH_GENESYS
