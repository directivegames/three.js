// WITH_GENESYS
// Shadow casters. Green when the object casts a shadow, gray when it does not.
// !WITH_GENESYS

import { Color } from '../../math/Color.js';
import { diffuseColor, diffuseContribution, metalness, roughness, specularColor, specularColorBlended, specularF90, clearcoat, sheen, iridescence, anisotropy, transmission, retroreflectivity } from '../core/PropertyNode.js';
import { uniform } from '../core/UniformNode.js';
import { float, vec3 } from '../tsl/TSLCore.js';

/**
 * Shadow casters. A mesh that casts shadows is green. One that does not is gray.
 * The color is lit, so form stays readable.
 *
 * Matches Unreal's simplified shadow-caster view (`GetCachedShadowCasterColorSimplified`):
 * green `(0, 1, 0)` casts, gray `(0.5, 0.5, 0.5)` does not. Contact-shadow yellow is omitted;
 * Three.js has no per-object contact-shadow flag.
 *
 * @type {string}
 */
export const DEBUG_VIEW_SHADOW_CASTER = 'shadowCaster';

const CASTS_COLOR = new Color( 0, 1, 0 );
const NONE_COLOR = new Color( 0.5, 0.5, 0.5 );

/**
 * Replaces albedo with the caster color after the material has written its channels.
 * Lit materials become a matte dielectric. Unlit materials become flat.
 * The color is an object uniform, so meshes that share a material still differ.
 *
 * @param {NodeBuilder} builder - The current node builder.
 * @param {NodeMaterial} material - The node material being set up. `builder.material` can be the
 * source material of a converted one, such as a glTF `MeshStandardMaterial`.
 */
export function applyShadowCasterDebug( builder, material ) {

	const colorNode = uniform( new Color() ).onObjectUpdate( ( { object }, self ) => {

		if ( object === null ) return;

		return self.value.copy( object.castShadow === true ? CASTS_COLOR : NONE_COLOR );

	} );

	diffuseColor.rgb.assign( colorNode );

	if ( material.lights !== true ) return;

	metalness.assign( float( 0 ) );
	diffuseContribution.assign( colorNode );
	roughness.assign( float( 1 ) );
	specularColor.assign( vec3( 0 ) );
	specularColorBlended.assign( vec3( 0 ) );
	specularF90.assign( float( 0 ) );

	builder.context.ambientOcclusion = null;

	if ( material.useClearcoat === true ) clearcoat.assign( float( 0 ) );

	if ( material.useSheen === true ) sheen.assign( vec3( 0 ) );

	if ( material.useIridescence === true ) iridescence.assign( float( 0 ) );

	if ( material.useAnisotropy === true ) anisotropy.assign( float( 0 ) );

	if ( material.useTransmission === true ) transmission.assign( float( 0 ) );

	if ( material.useRetroreflection === true ) retroreflectivity.assign( float( 0 ) );

}
