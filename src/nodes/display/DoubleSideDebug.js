// WITH_GENESYS
// Double sided. Gray is a single-sided surface or the front of a double-sided one.
// Blue is a double-sided back face you can see. Red is a double-sided back face hidden behind the front.
// !WITH_GENESYS

import Node from '../core/Node.js';
import { nodeImmutable } from '../tsl/TSLBase.js';
import { select } from '../math/ConditionalNode.js';
import { diffuseColor, diffuseContribution, metalness, roughness, specularColor, specularColorBlended, specularF90, clearcoat, sheen, iridescence, anisotropy, transmission, retroreflectivity } from '../core/PropertyNode.js';
import { float, vec3 } from '../tsl/TSLCore.js';
import { DoubleSide } from '../../constants.js';

/**
 * Double sided. A single-sided material is gray. A double-sided front face is gray.
 * A double-sided back face that is the nearest surface is blue. A later pass paints
 * a hidden double-sided back face red over the front.
 *
 * @type {string}
 */
export const DEBUG_VIEW_DOUBLE_SIDE = 'doubleSide';

/**
 * Rasterizer front face, ignoring the material side shortcut in {@link frontFacing}.
 */
class GeometricFrontFacingNode extends Node {

	static get type() {

		return 'GeometricFrontFacingNode';

	}

	constructor() {

		super( 'bool' );

	}

	generate( builder ) {

		if ( builder.shaderStage !== 'fragment' ) return 'true';

		return builder.getFrontFacing();

	}

}

const geometricFrontFacing = /*@__PURE__*/ nodeImmutable( GeometricFrontFacingNode );

const hideCache = new WeakMap();

/**
 * A flat card or wall has normals that all point the same way, so its back face is the same
 * surface. A box or a closed shell has normals that face each other, so one side can hide the other.
 *
 * @param {BufferGeometry} geometry - The mesh geometry.
 * @return {boolean} `true` when some normals oppose the first one.
 */
export function meshCanHideOwnBack( geometry ) {

	const normal = geometry.getAttribute( 'normal' );
	const cached = hideCache.get( geometry );

	if ( cached !== undefined && cached.version === geometry.version ) return cached.hides;

	let hides = false;

	if ( normal !== undefined && normal.count > 1 ) {

		const ax = normal.getX( 0 );
		const ay = normal.getY( 0 );
		const az = normal.getZ( 0 );
		const step = Math.max( 1, Math.floor( normal.count / 64 ) );

		for ( let i = step; i < normal.count; i += step ) {

			if ( ax * normal.getX( i ) + ay * normal.getY( i ) + az * normal.getZ( i ) < 0.25 ) {

				hides = true;
				break;

			}

		}

	}

	hideCache.set( geometry, { version: geometry.version, hides } );

	return hides;

}

const FRONT_COLOR = /*@__PURE__*/ vec3( 0.5, 0.5, 0.5 );
const BACK_COLOR = /*@__PURE__*/ vec3( 0.25, 0.45, 0.85 );
const HIDDEN_COLOR = /*@__PURE__*/ vec3( 0.85, 0.12, 0.1 );

/**
 * Makes a lit material a matte dielectric in the debug color. An unlit material stays flat.
 *
 * @param {NodeBuilder} builder - The current node builder.
 * @param {NodeMaterial} material - The node material being set up.
 * @param {Node} colorNode - The albedo written for this fragment.
 */
function assignLitColor( builder, material, colorNode ) {

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

/**
 * Replaces albedo after the material has written its channels.
 * The hidden pass forces red. The first pass uses gray, or blue on a visible double-sided back face.
 *
 * @param {NodeBuilder} builder - The current node builder.
 * @param {NodeMaterial} material - The node material being set up. `builder.material` can be the
 * source material of a converted one, such as a glTF `MeshStandardMaterial`.
 */
export function applyDoubleSideDebug( builder, material ) {

	const hidden = builder.renderer.debug.doubleSideHidden === true;
	const visibleBack = builder.renderer.debug.doubleSideBack === true;
	const doubleSided = material.side === DoubleSide;
	const colorNode = hidden ? HIDDEN_COLOR : ( visibleBack ? BACK_COLOR : ( doubleSided ? select( geometricFrontFacing, FRONT_COLOR, BACK_COLOR ) : FRONT_COLOR ) );

	assignLitColor( builder, material, colorNode );

}
