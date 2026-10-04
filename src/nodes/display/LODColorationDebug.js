// WITH_GENESYS
// LOD coloration. Each drawn LOD tier gets a fixed color from the palette, then lit.
// !WITH_GENESYS

import { Color } from '../../math/Color.js';
import { diffuseColor, diffuseContribution, metalness, roughness, specularColor, specularColorBlended, specularF90, clearcoat, sheen, iridescence, anisotropy, transmission, retroreflectivity } from '../core/PropertyNode.js';
import { uniform } from '../core/UniformNode.js';
import { float, vec3 } from '../tsl/TSLCore.js';

/**
 * LOD coloration. Colors geometry by its active LOD index, then lights that color.
 * Matches Unreal `LODColorationColors` from `BaseEngine.ini`.
 *
 * @type {string}
 */
export const DEBUG_VIEW_LOD_COLORATION = 'lodColoration';

/**
 * Default palette when `renderer.debug.lodColorationColors` is not set.
 * Unreal: white, red, green, blue, yellow, fuchsia, cyan, purple.
 *
 * @type {Color[]}
 */
export const DEFAULT_LOD_COLORATION_COLORS = [
	new Color( 1, 1, 1 ),
	new Color( 1, 0, 0 ),
	new Color( 0, 1, 0 ),
	new Color( 0, 0, 1 ),
	new Color( 1, 1, 0 ),
	new Color( 1, 0, 1 ),
	new Color( 0, 1, 1 ),
	new Color( 0.5, 0, 0.5 ),
];

const INVALID_LOD_COLOR = new Color( 1, 0, 1 );

/**
 * Resolves the LOD index used for coloration on a drawn object.
 * `userData.lodColorationIndex` on the object or an ancestor wins (Genesys instanced LOD tiers).
 * Otherwise the nearest `THREE.LOD` parent is consulted: the level object that owns the draw,
 * or the parent's current level as a fallback.
 *
 * @param {?Object3D} object - The drawn object.
 * @return {number} LOD index, or `-1` when no palette entry should be used.
 */
export function resolveLODColorationIndex( object ) {

	if ( object === null ) return - 1;

	let node = object;

	while ( node !== null ) {

		const tagged = node.userData.lodColorationIndex;

		if ( typeof tagged === 'number' && Number.isFinite( tagged ) ) {

			return tagged;

		}

		node = node.parent;

	}

	node = object;

	while ( node !== null ) {

		const parent = node.parent;

		if ( parent !== null && parent.isLOD === true ) {

			const levels = parent.levels;

			for ( let i = 0; i < levels.length; i ++ ) {

				const levelObject = levels[ i ].object;

				if ( levelObject === object || levelObject.getObjectById( object.id ) !== undefined ) {

					return i;

				}

			}

			return parent.getCurrentLevel();

		}

		node = parent;

	}

	return 0;

}

/**
 * @param {Color} color - Destination color.
 * @param {?Object3D} object - The drawn object.
 * @param {Renderer~DebugConfig} debug - Renderer debug state.
 * @return {Color} `color`.
 */
function writeLODColorationColor( color, object, debug ) {

	const index = resolveLODColorationIndex( object );
	const palette = debug.lodColorationColors ?? DEFAULT_LOD_COLORATION_COLORS;

	if ( index < 0 || index >= palette.length ) {

		return color.copy( INVALID_LOD_COLOR );

	}

	return color.copy( palette[ index ] );

}

/**
 * Replaces albedo with the LOD palette color after the material has written its channels.
 *
 * @param {NodeBuilder} builder - The current node builder.
 * @param {NodeMaterial} material - The node material being set up.
 */
export function applyLODColorationDebug( builder, material ) {

	const colorNode = uniform( new Color() ).onObjectUpdate( ( { object }, self ) => {

		if ( object === null ) return;

		return writeLODColorationColor( self.value, object, builder.renderer.debug );

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
