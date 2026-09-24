// WITH_GENESYS
// Front/back face. Both windings are drawn. The side facing the camera uses one color, the other side another.
// !WITH_GENESYS

import Node from '../core/Node.js';
import { nodeImmutable } from '../tsl/TSLBase.js';
import { select } from '../math/ConditionalNode.js';
import { diffuseColor, diffuseContribution, metalness, roughness, specularColor, specularColorBlended, specularF90, clearcoat, sheen, iridescence, anisotropy, transmission, retroreflectivity } from '../core/PropertyNode.js';
import { float, vec3 } from '../tsl/TSLCore.js';

/**
 * Front/back face. Culling is off. A fragment whose winding faces the camera is one color.
 * The opposite winding is another. Depth still hides a face behind the shell.
 *
 * @type {string}
 */
export const DEBUG_VIEW_FRONT_BACK_FACE = 'frontBackFace';

/**
 * Rasterizer front face, ignoring the material side shortcut in {@link frontFacing}.
 * `BackSide` materials otherwise report every fragment as back facing.
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

const FRONT_COLOR = /*@__PURE__*/ vec3( 0.72, 0.70, 0.66 );
const BACK_COLOR = /*@__PURE__*/ vec3( 0.25, 0.45, 0.85 );

/**
 * Replaces albedo with the front or back color after the material has written its channels.
 * Lit materials become a matte dielectric. Unlit materials become flat.
 *
 * @param {NodeBuilder} builder - The current node builder.
 * @param {NodeMaterial} material - The node material being set up.
 */
export function applyFrontBackFaceDebug( builder, material ) {

	const colorNode = select( geometricFrontFacing, FRONT_COLOR, BACK_COLOR );

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
