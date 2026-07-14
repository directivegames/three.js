import {
	LightsNode,
	// WITH_GENESYS
	MaterialLightsNode,
	// !WITH_GENESYS
} from '../../nodes/Nodes.js';

const _defaultLights = /*@__PURE__*/ new LightsNode();
const _weakMap = /*@__PURE__*/ new WeakMap();

/**
 * This renderer module manages the lights nodes which are unique
 * per scene and camera combination.
 *
 * The lights node itself is later configured in the render list
 * with the actual lights from the scene.
 *
 * @private
 */
class Lighting {

	/**
	 * Constructs a new lighting manager.
	 */
	constructor() {

		/**
		 * Whether this lighting manager is enabled or not.
		 *
		 * @type {boolean}
		 * @default true
		 */
		this.enabled = true;

		/**
		 * A stack of light arrays saved per render via {@link Lighting#beginRender}.
		 *
		 * @private
		 * @type {Array<Array<Light>>}
		 */
		this._cache = [];

	}

	/**
	 * Creates a new lights node for the given array of lights.
	 *
	 * @param {Array<Light>} lights - The render object.
	 * @return {LightsNode} The lights node.
	 */
	createNode( lights = [] ) {

		return new LightsNode().setLights( lights );

	}

	// WITH_GENESYS
	/**
	 * Creates a lights node that composes live scene lighting with material-local
	 * lighting nodes such as environment, AO and light map lighting.
	 *
	 * @param {LightsNode} lightsNode - The live scene lights node.
	 * @param {Array<LightingNode>} materialLights - Material-local lighting nodes.
	 * @return {MaterialLightsNode} The material lights node.
	 */
	createMaterialNode( lightsNode, materialLights = [] ) {

		return new MaterialLightsNode( lightsNode, materialLights );

	}
	// !WITH_GENESYS

	/**
	 * Returns a lights node for the given scene.
	 *
	 * @param {Scene} scene - The scene.
	 * @return {LightsNode} The lights node.
	 */
	getNode( scene ) {

		// Ignore renderable objects, e.g: Mesh, Sprite, etc.
		if ( scene.isScene !== true && scene.isGroup !== true ) return _defaultLights;

		let node = _weakMap.get( scene );

		if ( node === undefined ) {

			node = this.createNode();
			_weakMap.set( scene, node );

		}

		return node;

	}

	/**
	 * Saves the current lights of the scene's lights node so they can be restored
	 * in {@link Lighting#finishRender}. Must be paired with a `finishRender()` call
	 * to avoid memory leaks.
	 *
	 * Nested render calls might mutate the lights array so a save/restore is required
	 * for each render call.
	 *
	 * @param {Scene} scene - The scene.
	 */
	beginRender( scene ) {

		this._cache.push( this.getNode( scene ).getLights() );

	}

	/**
	 * Restores the lights saved by the matching {@link Lighting#beginRender} call.
	 *
	 * @param {Scene} scene - The scene.
	 */
	finishRender( scene ) {

		this.getNode( scene ).setLights( this._cache.pop() );

	}

}

export default Lighting;
