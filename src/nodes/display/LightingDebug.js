// WITH_GENESYS
// Lighting only and detail lighting. Both replace the shaded albedo with a flat gray.
// !WITH_GENESYS

import { diffuseColor, diffuseContribution, metalness, roughness, specularColor, specularColorBlended, specularF90, clearcoat, sheen, iridescence, anisotropy, transmission, retroreflectivity } from '../core/PropertyNode.js';
import { normalViewGeometry } from '../accessors/Normal.js';
import { negateOnBackSide } from './FrontFacingNode.js';
import { float, vec3, Fn } from '../tsl/TSLCore.js';

/**
 * Lighting only. Flat gray, no specular, geometry normals. Material detail is dropped.
 *
 * @type {string}
 */
export const DEBUG_VIEW_LIGHTING_ONLY = 'lightingOnly';

/**
 * Detail lighting. Flat gray and a constant specular, with normal maps and roughness kept.
 *
 * @type {string}
 */
export const DEBUG_VIEW_DETAIL_LIGHTING = 'detailLighting';

/**
 * Neutral albedo shared by both views. Matches Unreal's `LightingOnlyBrightness`.
 *
 * @type {number}
 */
const LIGHTING_ONLY_BRIGHTNESS = 0.3;

/**
 * Specular color used by detail lighting. Unreal writes `0.1` into the specular override.
 *
 * @type {number}
 */
const DETAIL_LIGHTING_SPECULAR = 0.1;

/**
 * Geometry normal for lighting only, so normal maps and `normalNode` do not shade the surface.
 *
 * @type {Node<vec3>}
 */
export const lightingOnlyNormal = /*@__PURE__*/ Fn( ( builder ) => {

	let node = normalViewGeometry;

	if ( builder.isFlatShading() !== true ) {

		node = negateOnBackSide( node );

	}

	return node;

}, 'vec3' );

/**
 * Replaces albedo and specular after the material has written its channels.
 * Lit materials become a dielectric gray. Unlit materials become flat gray.
 *
 * @param {NodeBuilder} builder - The current node builder.
 * @param {string} view - `renderer.debug.view`.
 */
export function applyLightingDebug( builder, view ) {

	const material = builder.material;
	const gray = vec3( LIGHTING_ONLY_BRIGHTNESS );

	diffuseColor.rgb.assign( gray );

	if ( material.lights !== true ) return;

	metalness.assign( float( 0 ) );
	diffuseContribution.assign( gray );

	if ( view === DEBUG_VIEW_LIGHTING_ONLY ) {

		roughness.assign( float( 1 ) );
		specularColor.assign( vec3( 0 ) );
		specularColorBlended.assign( vec3( 0 ) );
		specularF90.assign( float( 0 ) );

		// Ambient occlusion was stored for the lighting model. Lighting only has no material.
		builder.context.ambientOcclusion = null;

		if ( material.useClearcoat === true ) clearcoat.assign( float( 0 ) );

		if ( material.useSheen === true ) sheen.assign( vec3( 0 ) );

		if ( material.useIridescence === true ) iridescence.assign( float( 0 ) );

		if ( material.useAnisotropy === true ) anisotropy.assign( float( 0 ) );

		if ( material.useTransmission === true ) transmission.assign( float( 0 ) );

		if ( material.useRetroreflection === true ) retroreflectivity.assign( float( 0 ) );

	} else {

		const specular = vec3( DETAIL_LIGHTING_SPECULAR );

		specularColor.assign( specular );
		specularColorBlended.assign( specular );
		specularF90.assign( float( 1 ) );

	}

}
