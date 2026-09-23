// WITH_GENESYS
// Buffer visualization. Shows one material channel in place of the shaded color.
// !WITH_GENESYS

import { diffuseColor, ambientOcclusion, emissive, metalness, roughness } from '../core/PropertyNode.js';
import { normalWorld } from '../accessors/Normal.js';
import { float, vec3, vec4 } from '../tsl/TSLCore.js';

/**
 * Buffer visualization. The visible surface wins, and one material channel replaces the shaded color.
 *
 * @type {string}
 */
export const DEBUG_VIEW_BUFFER = 'bufferVisualization';

/**
 * Albedo before lighting, including maps and vertex colors.
 *
 * @type {string}
 */
export const BUFFER_BASE_COLOR = 'baseColor';

/**
 * Shading normal in world space, packed to RGB with `n * 0.5 + 0.5`.
 *
 * @type {string}
 */
export const BUFFER_WORLD_NORMAL = 'worldNormal';

/**
 * Scalar roughness used by the lighting model. Black is smooth.
 *
 * @type {string}
 */
export const BUFFER_ROUGHNESS = 'roughness';

/**
 * Scalar metalness. White is metal. Unreal calls this buffer Metallic.
 *
 * @type {string}
 */
export const BUFFER_METALLIC = 'metallic';

/**
 * Material ambient occlusion. White means no occlusion map.
 *
 * @type {string}
 */
export const BUFFER_AMBIENT_OCCLUSION = 'ambientOcclusion';

/**
 * Emissive color before it is added to the lit result.
 *
 * @type {string}
 */
export const BUFFER_EMISSIVE = 'emissive';

/**
 * Channel drawn when buffer visualization is first enabled.
 *
 * @type {string}
 */
export const DEFAULT_BUFFER = BUFFER_BASE_COLOR;

/**
 * Writes a defined value for channels a material may never assign.
 * Standard and physical materials overwrite roughness and metalness in `setupVariants`,
 * and emissive is overwritten when the material has one.
 *
 * @param {string} buffer - `renderer.debug.buffer`.
 */
export function assignBufferDefaults( buffer ) {

	if ( buffer === BUFFER_ROUGHNESS ) {

		roughness.assign( float( 0 ) );

	} else if ( buffer === BUFFER_METALLIC ) {

		metalness.assign( float( 0 ) );

	} else if ( buffer === BUFFER_EMISSIVE ) {

		emissive.assign( vec3( 0 ) );

	}

}

/**
 * The color for one buffer channel. Scalar channels are copied into RGB.
 *
 * @param {string} buffer - `renderer.debug.buffer`.
 * @return {Node<vec3>} The channel color.
 */
export function bufferVisualizationColor( buffer ) {

	if ( buffer === BUFFER_WORLD_NORMAL ) {

		return normalWorld.mul( 0.5 ).add( 0.5 );

	}

	if ( buffer === BUFFER_ROUGHNESS ) {

		return vec3( roughness );

	}

	if ( buffer === BUFFER_METALLIC ) {

		return vec3( metalness );

	}

	if ( buffer === BUFFER_AMBIENT_OCCLUSION ) {

		return vec3( ambientOcclusion );

	}

	if ( buffer === BUFFER_EMISSIVE ) {

		return emissive;

	}

	return diffuseColor.rgb;

}

/**
 * Replaces the shaded color with the selected buffer. Alpha stays the material's coverage
 * so masked and transparent surfaces keep their shape.
 *
 * @param {string} buffer - `renderer.debug.buffer`.
 * @return {Node<vec4>} The buffer color.
 */
export function bufferVisualizationOutput( buffer ) {

	return vec4( bufferVisualizationColor( buffer ), diffuseColor.a );

}
