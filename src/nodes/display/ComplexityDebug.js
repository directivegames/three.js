// WITH_GENESYS
// Shader and lighting complexity debug views. Costs are a material proxy, not ISA instruction counts.
// !WITH_GENESYS

import Node from '../core/Node.js';
import { float, vec3, vec4, If, Fn } from '../tsl/TSLCore.js';
import { fract, min, mix } from '../math/MathNode.js';

/**
 * Shaded output. No complexity debug view.
 *
 * @type {string}
 */
export const DEBUG_VIEW_NONE = 'none';

/**
 * Material-cost heatmap. Overlapping draws accumulate, then a fullscreen pass applies the ramp.
 *
 * @type {string}
 */
export const DEBUG_VIEW_SHADER_COMPLEXITY = 'shaderComplexity';

/**
 * Direct-light count heatmap. The visible surface wins.
 *
 * @type {string}
 */
export const DEBUG_VIEW_LIGHTING_COMPLEXITY = 'lightingComplexity';

/**
 * Proxy budget that fills the shader-complexity ramp.
 * Unlit and basic stay green. Phong and standard move through yellow into red.
 * Transmission plus several texture samples climbs toward white.
 *
 * @type {number}
 */
export const DEFAULT_SHADER_COMPLEXITY_BUDGET = 800;

/**
 * Added for each fragment texture sample. Lighting-model costs are returned
 * directly by {@link NodeMaterial#getShaderComplexity}.
 *
 * @type {number}
 */
export const SHADER_COMPLEXITY_TEXTURE_COST = 16;

/**
 * Attenuation above this counts as a light that shades the pixel.
 *
 * @type {number}
 */
export const LIGHTING_COMPLEXITY_EPSILON = 0.001;

/**
 * Added on top of 1 when a received light casts a shadow.
 * Applied even where the shadow map is black.
 *
 * @type {number}
 */
export const LIGHTING_COMPLEXITY_SHADOW_WEIGHT = 0.5;

/**
 * Unreal `ShaderComplexityColors` from `BaseEngine.ini`.
 *
 * @type {Array<Array<number>>}
 */
const SHADER_COMPLEXITY_COLORS = [
	[ 0.0, 1.0, 0.127 ],
	[ 0.0, 1.0, 0.0 ],
	[ 0.046, 0.52, 0.0 ],
	[ 0.215, 0.215, 0.0 ],
	[ 0.52, 0.046, 0.0 ],
	[ 0.7, 0.0, 0.0 ],
	[ 1.0, 0.0, 0.0 ],
	[ 1.0, 0.0, 0.5 ],
	[ 1.0, 0.9, 0.9 ]
];

/**
 * Unreal `LightComplexityColors` from `BaseEngine.ini`.
 *
 * @type {Array<Array<number>>}
 */
const LIGHT_COMPLEXITY_COLORS = [
	[ 0.0, 0.0, 0.0 ],
	[ 0.0, 0.0, 0.4 ],
	[ 0.0, 0.3, 1.0 ],
	[ 0.0, 0.7, 0.4 ],
	[ 0.0, 1.0, 0.0 ],
	[ 0.8, 0.8, 0.0 ],
	[ 1.0, 0.3, 0.0 ],
	[ 0.7, 0.0, 0.0 ],
	[ 0.5, 0.0, 0.5 ],
	[ 0.7, 0.3, 0.7 ],
	[ 1.0, 0.9, 0.9 ]
];

const rgb = ( colors, index ) => vec3( colors[ index ][ 0 ], colors[ index ][ 1 ], colors[ index ][ 2 ] );

/**
 * Linear sample of a fixed RGB ramp. `cost` is in steps, and one step is one light.
 *
 * @param {Node<float>} cost - Complexity in ramp steps.
 * @param {Array<Array<number>>} colors - Ramp stops.
 * @return {Node<vec3>} The ramp color.
 */
const colorizeLinear = ( cost, colors ) => {

	const steps = colors.length - 1;
	const expanded = cost.div( steps ).clamp( 0, 0.999 ).mul( steps );
	const index = expanded.floor();
	const frac = fract( expanded );

	let color = rgb( colors, 0 );

	for ( let i = 0; i < steps; i ++ ) {

		const sample = mix( rgb( colors, i ), rgb( colors, i + 1 ), frac );

		color = index.greaterThanEqual( float( i ) ).and( index.lessThan( float( i + 1 ) ) ).select( sample, color );

	}

	return color;

};

/**
 * Maps a direct-light cost through Unreal's light-complexity ramp.
 * Ten lights saturate at white.
 *
 * @param {Node<float>} cost - Accumulated light weight.
 * @return {Node<vec3>} The ramp color.
 */
export const colorizeLightComplexity = ( cost ) => colorizeLinear( cost, LIGHT_COMPLEXITY_COLORS );

/**
 * Unreal's nonlinear shader-complexity ramp (`ColorizeComplexity`).
 * The first third of the normalized cost spreads across the first seven stops.
 *
 * @param {Node<float>} complexity - Accumulated cost divided by the budget.
 * @return {Node<vec3>} The ramp color.
 */
export const colorizeShaderComplexity = /*@__PURE__*/ Fn( ( [ complexity ] ) => {

	const c = complexity.clamp( 0, 0.999 );
	const expanded = min( float( SHADER_COMPLEXITY_COLORS.length - 2 ), c.mul( 18 ) );
	const color = vec3( 0 ).toVar();
	const frac = fract( expanded );

	If( expanded.lessThan( 1 ), () => {

		color.assign( mix( rgb( SHADER_COMPLEXITY_COLORS, 0 ), rgb( SHADER_COMPLEXITY_COLORS, 1 ), frac ) );

	} ).ElseIf( expanded.lessThan( 2 ), () => {

		color.assign( mix( rgb( SHADER_COMPLEXITY_COLORS, 1 ), rgb( SHADER_COMPLEXITY_COLORS, 2 ), frac ) );

	} ).ElseIf( expanded.lessThan( 3 ), () => {

		color.assign( mix( rgb( SHADER_COMPLEXITY_COLORS, 2 ), rgb( SHADER_COMPLEXITY_COLORS, 3 ), frac ) );

	} ).ElseIf( expanded.lessThan( 4 ), () => {

		color.assign( mix( rgb( SHADER_COMPLEXITY_COLORS, 3 ), rgb( SHADER_COMPLEXITY_COLORS, 4 ), frac ) );

	} ).ElseIf( expanded.lessThan( 5 ), () => {

		color.assign( mix( rgb( SHADER_COMPLEXITY_COLORS, 4 ), rgb( SHADER_COMPLEXITY_COLORS, 5 ), frac ) );

	} ).ElseIf( expanded.lessThan( 6 ), () => {

		color.assign( mix( rgb( SHADER_COMPLEXITY_COLORS, 5 ), rgb( SHADER_COMPLEXITY_COLORS, 6 ), frac ) );

	} ).Else( () => {

		// Nine stops, so the upper range uses the `count > 8` scale of 3.
		const upper = c.sub( 0.33333333 ).mul( 3.0 );
		const upperFrac = fract( upper );

		If( upper.lessThanEqual( 1 ), () => {

			color.assign( mix( rgb( SHADER_COMPLEXITY_COLORS, 6 ), rgb( SHADER_COMPLEXITY_COLORS, 7 ), upperFrac ) );

		} ).Else( () => {

			color.assign( mix( rgb( SHADER_COMPLEXITY_COLORS, 7 ), rgb( SHADER_COMPLEXITY_COLORS, 8 ), upperFrac ) );

		} );

	} );

	return color;

} );

/**
 * Reads the builder's shader-complexity proxy at code-generation time,
 * after the real material graph has been generated and texture samples counted.
 *
 * @augments Node
 */
class ShaderComplexityRatioNode extends Node {

	static get type() {

		return 'ShaderComplexityRatioNode';

	}

	constructor() {

		super( 'float' );

	}

	generate( builder ) {

		const budget = builder.renderer.debug.shaderComplexityBudget;
		const safeBudget = ( typeof budget === 'number' && budget > 0 ) ? budget : 1;
		const ratio = builder.getShaderComplexityCost() / safeBudget;

		return ratio.toFixed( 6 );

	}

}

/**
 * Replaces the shaded color with `vec4(cost / budget, 0, 0, 1)`.
 * The real graph is still generated so texture samples are counted first.
 *
 * @param {Node} resultNode - The material's shaded output.
 * @return {Node<vec4>} The complexity ratio in the red channel.
 */
export function shaderComplexityOutput( resultNode ) {

	// Generate the shaded graph first so texture samples are counted, then
	// replace the color. A bypass of a value node emits a bare expression
	// statement, which WGSL rejects.
	const shaded = vec4( resultNode ).toVar();

	const ratio = new ShaderComplexityRatioNode();

	return vec4( ratio, 0, 0, 1 ).add( shaded.mul( 0 ) );

}
