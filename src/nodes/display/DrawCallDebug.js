// WITH_GENESYS
// Draw call coloration. One stable diffuse color per submitted draw, then lit.
// !WITH_GENESYS

import { Color } from '../../math/Color.js';
import { diffuseColor, diffuseContribution, metalness, roughness, specularColor, specularColorBlended, specularF90, clearcoat, sheen, iridescence, anisotropy, transmission, retroreflectivity } from '../core/PropertyNode.js';
import { uniform } from '../core/UniformNode.js';
import { float, vec3 } from '../tsl/TSLCore.js';

/**
 * Draw call coloration. Each submitted draw gets one diffuse color. An instanced mesh is one draw.
 * The color is lit, so lights and shadows still show. Unlit materials stay flat.
 *
 * @type {string}
 */
export const DEBUG_VIEW_DRAW_CALL = 'drawCall';

/**
 * Golden-ratio step. Sequential object ids land on opposite sides of the hue wheel.
 *
 * @type {number}
 */
const DRAW_CALL_HUE_STEP = 0.618033988749895;

/**
 * Saturation of a draw color. High enough that neighboring hues stay apart after lighting.
 *
 * @type {number}
 */
const DRAW_CALL_SATURATION = 0.85;

/**
 * Value of a draw color. Lighting and shadows darken it from here.
 *
 * @type {number}
 */
const DRAW_CALL_VALUE = 0.92;

/**
 * Writes a saturated color for this draw into `color`.
 * Hue walks the wheel by the golden ratio, so consecutive objects do not share a tint.
 * Instances of one mesh share the object id, so they share the color.
 *
 * @param {Color} color - The uniform color, updated in place.
 * @param {Object3D} object - The drawn object.
 * @param {Material} material - The drawn material. A multi-material group is its own draw.
 * @return {Color} `color`.
 */
function writeDrawCallColor( color, object, material ) {

	const hue = ( ( object.id + material.id * 64 ) * DRAW_CALL_HUE_STEP ) % 1;
	const s = DRAW_CALL_SATURATION;
	const v = DRAW_CALL_VALUE;
	const sector = hue * 6;
	const i = Math.floor( sector );
	const f = sector - i;
	const p = v * ( 1 - s );
	const q = v * ( 1 - f * s );
	const t = v * ( 1 - ( 1 - f ) * s );

	switch ( i % 6 ) {

		case 0: return color.setRGB( v, t, p );
		case 1: return color.setRGB( q, v, p );
		case 2: return color.setRGB( p, v, t );
		case 3: return color.setRGB( p, q, v );
		case 4: return color.setRGB( t, p, v );
		default: return color.setRGB( v, p, q );

	}

}

/**
 * Replaces albedo with the draw color after the material has written its channels.
 * Lit materials become a matte dielectric in that color. Unlit materials become flat.
 * The color is an object uniform, so meshes that share a material still differ.
 *
 * @param {NodeBuilder} builder - The current node builder.
 * @param {NodeMaterial} material - The node material being set up. `builder.material` can be the
 * source material of a converted one, such as a glTF `MeshStandardMaterial`.
 */
export function applyDrawCallDebug( builder, material ) {

	const colorNode = uniform( new Color() ).onObjectUpdate( ( { object, material: drawnMaterial }, self ) => {

		if ( object === null || drawnMaterial === null ) return;

		return writeDrawCallColor( self.value, object, drawnMaterial );

	} );

	diffuseColor.rgb.assign( colorNode );

	if ( material.lights !== true ) return;

	metalness.assign( float( 0 ) );
	diffuseContribution.assign( colorNode );
	roughness.assign( float( 1 ) );
	specularColor.assign( vec3( 0 ) );
	specularColorBlended.assign( vec3( 0 ) );
	specularF90.assign( float( 0 ) );

	// Ambient occlusion belonged to the original material.
	builder.context.ambientOcclusion = null;

	if ( material.useClearcoat === true ) clearcoat.assign( float( 0 ) );

	if ( material.useSheen === true ) sheen.assign( vec3( 0 ) );

	if ( material.useIridescence === true ) iridescence.assign( float( 0 ) );

	if ( material.useAnisotropy === true ) anisotropy.assign( float( 0 ) );

	if ( material.useTransmission === true ) transmission.assign( float( 0 ) );

	if ( material.useRetroreflection === true ) retroreflectivity.assign( float( 0 ) );

}
