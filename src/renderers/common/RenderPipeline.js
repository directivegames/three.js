import NodeMaterial from '../../materials/nodes/NodeMaterial.js';
import { ColorManagement } from '../../math/ColorManagement.js';
import { vec4, renderOutput, context } from '../../nodes/TSL.js';
import { NoToneMapping } from '../../constants.js';
import QuadMesh from '../../renderers/common/QuadMesh.js';
import { warnOnce } from '../../utils.js';
// WITH_GENESYS
import { debugViewAccumulates, debugViewSkipsToneMapping } from '../../nodes/display/ComplexityDebug.js';
// !WITH_GENESYS

// WITH_GENESYS
/**
 * Calls `dispose()` once on every node reachable from the given roots.
 *
 * @private
 * @param {Array<Node>} roots - The root nodes. Entries that are not nodes are ignored.
 */
function disposeNodeGraph( roots ) {

	const visited = new Set();
	const stack = [];

	for ( const root of roots ) {

		if ( root && root.isNode === true ) stack.push( root );

	}

	while ( stack.length > 0 ) {

		const node = stack.pop();

		if ( visited.has( node ) ) continue;

		visited.add( node );

		for ( const child of node.getChildren() ) {

			if ( visited.has( child ) === false ) stack.push( child );

		}

	}

	for ( const node of visited ) {

		try {

			node.dispose();

		} catch ( error ) {

			console.warn( 'RenderPipeline: Failed to dispose node.', error );

		}

	}

}
// !WITH_GENESYS

/**
 * This module is responsible to manage the rendering pipeline setups in apps.
 * You usually create a single instance of this class and use it to define
 * the output of your render pipeline and post processing effect chain.
 * ```js
 * const renderPipeline = new RenderPipeline( renderer );
 *
 * const scenePass = pass( scene, camera );
 *
 * renderPipeline.outputNode = scenePass;
 * ```
 *
 * Note: This module can only be used with `WebGPURenderer`.
 */
class RenderPipeline {

	/**
	 * Constructs a new render pipeline management module.
	 *
	 * @param {Renderer} renderer - A reference to the renderer.
	 * @param {Node<vec4>} outputNode - An optional output node.
	 */
	constructor( renderer, outputNode = vec4( 0, 0, 1, 1 ) ) {

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isRenderPipeline = true;

		/**
		 * A reference to the renderer.
		 *
		 * @type {Renderer}
		 */
		this.renderer = renderer;

		/**
		 * A node which defines the final output of the rendering
		 * pipeline. This is usually the last node in a chain
		 * of effect nodes.
		 *
		 * @type {Node<vec4>}
		 */
		this.outputNode = outputNode;

		/**
		 * Whether the default output tone mapping and color
		 * space transformation should be enabled or not.
		 *
		 * This is enabled by default but it must be disabled for
		 * effects that expect to be executed after tone mapping and color
		 * space conversion. A typical example is FXAA which
		 * requires sRGB input.
		 *
		 * When set to `false`, the app must control the output
		 * transformation with `RenderOutputNode`.
		 *
		 * ```js
		 * const outputPass = renderOutput( scenePass );
		 * ```
		 *
		 * @type {boolean}
		 */
		this.outputColorTransform = true;

		/**
		 * Must be set to `true` when the output node changes.
		 *
		 * @type {Node<vec4>}
		 */
		this.needsUpdate = true;

		// WITH_GENESYS
		/**
		 * Extra root nodes released by {@link RenderPipeline#dispose} together with the graph under
		 * {@link RenderPipeline#outputNode}. Add nodes that were built for this pipeline but are not
		 * reachable from the output node, for example stages whose result nothing reads or that were
		 * pruned from the chain. Their render targets are otherwise never freed.
		 *
		 * Nodes that the pipeline's quads update while rendering are added automatically. That covers
		 * nodes created during the shader build (such as `convertToTexture()` inside a `Fn()` body),
		 * which no graph walk can reach.
		 *
		 * @type {Set<Node>}
		 */
		this.ownedNodes = new Set();
		// !WITH_GENESYS

		const material = new NodeMaterial();
		material.name = 'RenderPipeline';

		/**
		 * The full screen quad that is used to render
		 * the effects.
		 *
		 * @private
		 * @type {QuadMesh}
		 */
		this._quadMesh = new QuadMesh( material );
		this._quadMesh.name = 'Render Pipeline';

		/**
		 * The context data for the render pipeline.
		 *
		 * @private
		 * @type {?Object}
		 * @default null
		 */
		this._contextData = null;

		/**
		 * The current tone mapping.
		 *
		 * @private
		 * @type {ToneMapping}
		 */
		this._toneMapping = renderer.toneMapping;

		/**
		 * The current output color space.
		 *
		 * @private
		 * @type {ColorSpace}
		 */
		this._outputColorSpace = renderer.outputColorSpace;


	}

	// WITH_GENESYS
	/**
	 * Name of the output quad, used as its profiler scope and GPU pass label.
	 *
	 * @type {string}
	 * @default 'Render Pipeline'
	 */
	get name() {

		return this._quadMesh.name;

	}

	set name( value ) {

		this._quadMesh.name = value;

	}
	// !WITH_GENESYS

	/**
	 * When `RenderPipeline` is used to apply rendering pipeline and post processing effects,
	 * the application must use this version of `render()` inside
	 * its animation loop (not the one from the renderer).
	 */
	render() {

		const renderer = this.renderer;

		this._update();

		for ( const callback of this._contextData.onBeforePipelineCallbacks ) callback();

		const toneMapping = renderer.toneMapping;
		const outputColorSpace = renderer.outputColorSpace;

		renderer.toneMapping = NoToneMapping;

		// WITH_GENESYS
		// Accumulating views colorize in the renderer's output pass, which must still encode the color space.
		if ( debugViewAccumulates( renderer.debug.view ) !== true ) renderer.outputColorSpace = ColorManagement.workingColorSpace;
		// !WITH_GENESYS
		// renderer.outputColorSpace = ColorManagement.workingColorSpace;

		//

		const currentXR = renderer.xr.enabled;
		renderer.xr.enabled = false;

		// WITH_GENESYS
		// Lets the node manager hand this pipeline the nodes its quads update, including nodes created
		// while the shader is built that no graph walk can reach (see NodeManager#_getRenderPipelineOwnedNodes).
		const previousRenderPipeline = renderer._activeRenderPipeline;
		renderer._activeRenderPipeline = this;

		try {

			this._quadMesh.render( renderer );

		} finally {

			renderer._activeRenderPipeline = previousRenderPipeline;

		}
		// !WITH_GENESYS
		// this._quadMesh.render( renderer );

		renderer.xr.enabled = currentXR;

		//

		renderer.toneMapping = toneMapping;
		renderer.outputColorSpace = outputColorSpace;

		for ( const callback of this._contextData.onAfterPipelineCallbacks ) callback();

	}

	/**
	 * Frees internal resources.
	 */
	dispose() {

		// WITH_GENESYS
		// Upstream only frees the quad material. The pass, render-to-texture, and effect nodes below
		// the output node (and anything in `ownedNodes`) own screen-sized render targets that are only
		// released through `Node.dispose()`; without this each pipeline rebuild leaks them on the GPU.
		disposeNodeGraph( [ this.outputNode, ...this.ownedNodes ] );
		this.ownedNodes.clear();
		// !WITH_GENESYS

		this._quadMesh.material.dispose();

	}

	/**
	 * Updates the context data.
	 *
	 * @private
	 */
	_updateContext() {

		const toneMapping = this._toneMapping;
		const outputColorSpace = this._outputColorSpace;

		const contextData = {
			renderPipeline: this,
			renderPipelineState: {
				viewOffsetOwner: null
			},
			onBeforePipelineCallbacks: [],
			onAfterPipelineCallbacks: []
		};

		let outputNode = this.outputNode;

		if ( this.outputColorTransform === true ) {

			outputNode = renderOutput( outputNode, toneMapping, outputColorSpace );

		} else {

			contextData.toneMapping = toneMapping;
			contextData.outputColorSpace = outputColorSpace;

		}

		this._contextData = contextData;

		this._quadMesh.material.contextNode = context( contextData );
		this._quadMesh.material.fragmentNode = outputNode;
		this._quadMesh.material.needsUpdate = true;

	}

	/**
	 * Updates the state of the module.
	 *
	 * @private
	 */
	_update() {

		// WITH_GENESYS
		// Debug views drawn without tone mapping must match the direct path. An accumulating
		// view copies the raw ratio here, and the renderer's output pass colorizes it.
		const view = this.renderer.debug.view;
		const toneMapping = debugViewSkipsToneMapping( view ) ? NoToneMapping : this.renderer.toneMapping;
		const outputColorSpace = debugViewAccumulates( view ) ? ColorManagement.workingColorSpace : this.renderer.outputColorSpace;

		if ( this._toneMapping !== toneMapping ) {

			this._toneMapping = toneMapping;
			this.needsUpdate = true;

		}

		if ( this._outputColorSpace !== outputColorSpace ) {

			this._outputColorSpace = outputColorSpace;
			this.needsUpdate = true;

		}
		// !WITH_GENESYS
		// if ( this._toneMapping !== this.renderer.toneMapping ) {
		//
		// 	this._toneMapping = this.renderer.toneMapping;
		// 	this.needsUpdate = true;
		//
		// }
		//
		// if ( this._outputColorSpace !== this.renderer.outputColorSpace ) {
		//
		// 	this._outputColorSpace = this.renderer.outputColorSpace;
		// 	this.needsUpdate = true;
		//
		// }

		if ( this.needsUpdate === true ) {

			this._updateContext();

			this.needsUpdate = false;

		}

	}

	/**
	 * When `RenderPipeline` is used to apply rendering pipeline and post processing effects,
	 * the application must use this version of `renderAsync()` inside
	 * its animation loop (not the one from the renderer).
	 *
	 * @async
	 * @deprecated
	 * @return {Promise} A Promise that resolves when the render has been finished.
	 */
	async renderAsync() {

		warnOnce( 'RenderPipeline: "renderAsync()" has been deprecated. Use "render()" and "await renderer.init();" when creating the renderer.' ); // @deprecated r181

		await this.renderer.init();

		this.render();

	}

}

export default RenderPipeline;
