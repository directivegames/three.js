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
	 * Returns a lights node for the given scene and camera.
	 *
	 * @param {Scene} scene - The scene.
	 * @param {Camera} camera - The camera.
	 * @return {LightsNode} The lights node.
	 */
	getNode( scene ) {

		// ignore post-processing

		if ( scene.isQuadMesh ) return _defaultLights;

		let node = _weakMap.get( scene );

		if ( node === undefined ) {

			node = this.createNode();
			_weakMap.set( scene, node );

		}

		return node;

	}

}

export default Lighting;
