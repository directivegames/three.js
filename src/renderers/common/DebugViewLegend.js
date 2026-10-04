// WITH_GENESYS
// Viewport legend for renderer.debug views that use fixed ramps or symbolic colors.
// !WITH_GENESYS

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

const QUAD_OVERDRAW_COLORS = [
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

const LIGHT_COMPLEXITY_COLORS = QUAD_OVERDRAW_COLORS;

const DEFAULT_LOD_LABELS = [
	'LOD 0',
	'LOD 1',
	'LOD 2',
	'LOD 3',
	'LOD 4',
	'LOD 5',
	'LOD 6',
	'LOD 7'
];

const DEFAULT_LOD_COLORS = [
	[ 1, 1, 1 ],
	[ 1, 0, 0 ],
	[ 0, 1, 0 ],
	[ 0, 0, 1 ],
	[ 1, 1, 0 ],
	[ 1, 0, 1 ],
	[ 0, 1, 1 ],
	[ 0.5, 0, 0.5 ]
];

const LEGEND_DEBUG_KEYS = new Set( [
	'view',
	'buffer',
	'shaderComplexityBudget',
	'quadOverdrawBudget'
] );

let _stylesInjected = false;

function injectStyles() {

	if ( _stylesInjected === true || typeof document === 'undefined' ) return;

	_stylesInjected = true;

	const style = document.createElement( 'style' );
	style.textContent = `
.three-debug-view-legend {
	position: absolute;
	left: 12px;
	bottom: 12px;
	z-index: 900;
	max-width: min( 420px, calc( 100% - 24px ) );
	padding: 10px 12px;
	border-radius: 8px;
	border: 1px solid rgba( 74, 74, 90, 0.55 );
	background: rgba( 30, 30, 36, 0.88 );
	color: #e0e0e0;
	font: 12px/1.35 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
	pointer-events: none;
	backdrop-filter: blur( 8px );
	box-shadow: 0 4px 15px rgba( 0, 0, 0, 0.35 );
}

.three-debug-view-legend[ hidden ] {
	display: none !important;
}

.three-debug-view-legend-title {
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.02em;
	text-transform: uppercase;
	color: #9a9aab;
	margin-bottom: 6px;
}

.three-debug-view-legend-caption {
	margin-top: 6px;
	color: #9a9aab;
	font-size: 11px;
}

.three-debug-view-legend-ramp {
	height: 10px;
	border-radius: 4px;
	border: 1px solid rgba( 255, 255, 255, 0.12 );
	margin: 4px 0 6px;
}

.three-debug-view-legend-items {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 12px;
}

.three-debug-view-legend-item {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	white-space: nowrap;
}

.three-debug-view-legend-swatch {
	width: 10px;
	height: 10px;
	border-radius: 2px;
	border: 1px solid rgba( 255, 255, 255, 0.2 );
	flex-shrink: 0;
}

.three-debug-view-legend-textonly {
	color: #c8c8d4;
}
`;

	document.head.appendChild( style );

}

function rgbToCss( rgb ) {

	const r = Math.round( rgb[ 0 ] * 255 );
	const g = Math.round( rgb[ 1 ] * 255 );
	const b = Math.round( rgb[ 2 ] * 255 );

	return `rgb( ${ r }, ${ g }, ${ b } )`;

}

function rampGradient( colors ) {

	const stops = colors.map( ( c, i ) => `${ rgbToCss( c ) } ${ ( i / ( colors.length - 1 ) ) * 100 }%` );

	return `linear-gradient( to right, ${ stops.join( ', ' ) } )`;

}

function legendRamp( labelLow, labelHigh, colors, caption ) {

	return {
		title: null,
		ramp: rampGradient( colors ),
		rampLabels: [ labelLow, labelHigh ],
		items: null,
		caption
	};

}

function legendItems( title, items, caption ) {

	return {
		title,
		ramp: null,
		rampLabels: null,
		items,
		caption
	};

}

/**
 * @param {Renderer~DebugConfig} debug
 * @return {?object}
 */
function getLegendSpec( debug ) {

	const view = debug.view;
	const buffer = debug.buffer;

	if ( view === 'shaderComplexity' || view === 'shaderComplexityAndOverdraw' ) {

		const budget = debug.shaderComplexityBudget ?? 800;

		return legendRamp(
			'Low cost',
			`Budget (${ budget })`,
			SHADER_COMPLEXITY_COLORS,
			view === 'shaderComplexityAndOverdraw'
				? 'Shader cost multiplied by overlapping fragment count.'
				: 'Estimated material shading cost.'
		);

	}

	if ( view === 'lightingComplexity' ) {

		return legendRamp(
			'No lights',
			'~10 lights',
			LIGHT_COMPLEXITY_COLORS,
			'Direct lights per pixel. Shadow casters count as 1.5.'
		);

	}

	if ( view === 'overdraw' ) {

		const budget = debug.quadOverdrawBudget ?? 10;

		return legendRamp(
			'1 fragment',
			`Budget (${ budget })`,
			QUAD_OVERDRAW_COLORS,
			'Fragments that pass the depth test per pixel.'
		);

	}

	if ( view === 'lodColoration' ) {

		const palette = debug.lodColorationColors;
		const items = [];

		for ( let i = 0; i < DEFAULT_LOD_LABELS.length; i ++ ) {

			const color = palette && palette[ i ] ? palette[ i ] : DEFAULT_LOD_COLORS[ i ];
			const rgb = color.isColor ? [ color.r, color.g, color.b ] : DEFAULT_LOD_COLORS[ i ];

			items.push( { color: rgbToCss( rgb ), label: DEFAULT_LOD_LABELS[ i ] } );

		}

		return legendItems( 'LOD coloration', items, 'Palette matches Unreal LODColorationColors.' );

	}

	if ( view === 'doubleSide' ) {

		return legendItems( 'Double side', [
			{ color: rgbToCss( [ 0.5, 0.5, 0.5 ] ), label: 'Single-sided or front' },
			{ color: rgbToCss( [ 0.25, 0.45, 0.85 ] ), label: 'Visible back face' },
			{ color: rgbToCss( [ 0.85, 0.12, 0.1 ] ), label: 'Hidden back face' }
		], null );

	}

	if ( view === 'drawCall' ) {

		return {
			title: 'Draw call',
			ramp: null,
			rampLabels: null,
			items: null,
			caption: 'Each color is one submitted draw. Instanced meshes share one color.'
		};

	}

	if ( view === 'shadowCaster' ) {

		return legendItems( 'Shadow caster', [
			{ color: rgbToCss( [ 0, 1, 0 ] ), label: 'Casts shadows' },
			{ color: rgbToCss( [ 0.5, 0.5, 0.5 ] ), label: 'Does not cast' }
		], null );

	}

	if ( view === 'frontBackFace' ) {

		return legendItems( 'Front / back face', [
			{ color: rgbToCss( [ 0.72, 0.70, 0.66 ] ), label: 'Facing camera' },
			{ color: rgbToCss( [ 0.25, 0.45, 0.85 ] ), label: 'Opposite winding' }
		], null );

	}

	if ( view === 'bufferVisualization' ) {

		if ( buffer === 'worldNormal' ) {

			return legendItems( 'World normal', [
				{ color: rgbToCss( [ 0.5, 0.5, 1 ] ), label: '+X' },
				{ color: rgbToCss( [ 0.5, 1, 0.5 ] ), label: '+Y (up)' },
				{ color: rgbToCss( [ 1, 0.5, 0.5 ] ), label: '+Z' }
			], 'Encoded as normal × 0.5 + 0.5.' );

		}

		if ( buffer === 'roughness' ) {

			return legendRamp( 'Smooth', 'Rough', [[ 0, 0, 0 ], [ 1, 1, 1 ]], null );

		}

		if ( buffer === 'metallic' ) {

			return legendRamp( 'Dielectric', 'Metal', [[ 0, 0, 0 ], [ 1, 1, 1 ]], null );

		}

		if ( buffer === 'ambientOcclusion' ) {

			return legendRamp( 'Occluded', 'None', [[ 0.2, 0.2, 0.2 ], [ 1, 1, 1 ]], 'White when no AO map is applied.' );

		}

		if ( buffer === 'emissive' ) {

			return legendRamp( 'None', 'Bright', [[ 0, 0, 0 ], [ 1, 1, 1 ]], 'Emissive color only, no lighting.' );

		}

	}

	return null;

}

function renderSpec( root, spec ) {

	root.replaceChildren();

	if ( spec.title ) {

		const title = document.createElement( 'div' );
		title.className = 'three-debug-view-legend-title';
		title.textContent = spec.title;
		root.appendChild( title );

	}

	if ( spec.ramp ) {

		const ramp = document.createElement( 'div' );
		ramp.className = 'three-debug-view-legend-ramp';
		ramp.style.background = spec.ramp;
		root.appendChild( ramp );

		if ( spec.rampLabels ) {

			const labels = document.createElement( 'div' );
			labels.className = 'three-debug-view-legend-items';
			labels.style.justifyContent = 'space-between';
			labels.style.width = '100%';

			for ( const label of spec.rampLabels ) {

				const item = document.createElement( 'span' );
				item.className = 'three-debug-view-legend-item';
				item.textContent = label;
				labels.appendChild( item );

			}

			root.appendChild( labels );

		}

	}

	if ( spec.items ) {

		const row = document.createElement( 'div' );
		row.className = 'three-debug-view-legend-items';

		for ( const entry of spec.items ) {

			const item = document.createElement( 'span' );
			item.className = 'three-debug-view-legend-item';

			const swatch = document.createElement( 'span' );
			swatch.className = 'three-debug-view-legend-swatch';
			swatch.style.background = entry.color;

			const text = document.createElement( 'span' );
			text.textContent = entry.label;

			item.append( swatch, text );
			row.appendChild( item );

		}

		root.appendChild( row );

	}

	if ( spec.caption ) {

		const caption = document.createElement( 'div' );
		caption.className = spec.items === null && spec.ramp === null
			? 'three-debug-view-legend-textonly'
			: 'three-debug-view-legend-caption';
		caption.textContent = spec.caption;
		root.appendChild( caption );

	}

}

/**
 * Wraps `renderer.debug` so legend-related assignments refresh the overlay immediately.
 *
 * @param {Renderer} renderer
 * @param {Renderer~DebugConfig} debug
 * @return {Renderer~DebugConfig}
 */
function wrapDebugConfigForLegend( renderer, debug ) {

	return new Proxy( debug, {

		set( target, prop, value ) {

			const changed = target[ prop ] !== value;

			target[ prop ] = value;

			if ( changed === true && LEGEND_DEBUG_KEYS.has( prop ) ) {

				renderer._syncDebugViewLegend();

			}

			return true;

		}

	} );

}

/**
 * DOM overlay that explains the active `renderer.debug` view.
 */
class DebugViewLegend {

	constructor() {

		if ( typeof document === 'undefined' ) {

			this.domElement = null;
			this._parent = null;
			this._signature = '';
			return;

		}

		injectStyles();

		this.domElement = document.createElement( 'div' );
		this.domElement.className = 'three-debug-view-legend';
		this.domElement.hidden = true;

		this._parent = null;
		this._signature = '';

	}

	/**
	 * @param {HTMLElement} parent - Usually the canvas container.
	 */
	_mountParent( parent ) {

		if ( this.domElement === null || parent === this._parent ) return;

		if ( this._parent !== null ) {

			this.domElement.remove();

		}

		this._parent = parent;

		if ( getComputedStyle( parent ).position === 'static' ) {

			parent.style.position = 'relative';

		}

		parent.appendChild( this.domElement );

	}

	/**
	 * @param {Renderer} renderer
	 */
	sync( renderer ) {

		if ( this.domElement === null ) return;

		if ( renderer === null || renderer.debug === undefined ) {

			this.domElement.hidden = true;
			return;

		}

		const parent = renderer.domElement.parentElement;

		if ( parent !== null ) {

			this._mountParent( parent );

		}

		const debug = renderer.debug;
		const signature = `${ debug.view }:${ debug.buffer ?? '' }:${ debug.shaderComplexityBudget }:${ debug.quadOverdrawBudget }`;

		const spec = getLegendSpec( debug );

		if ( spec === null ) {

			this.domElement.hidden = true;
			this._signature = '';
			return;

		}

		this.domElement.hidden = false;

		if ( signature !== this._signature ) {

			renderSpec( this.domElement, spec );
			this._signature = signature;

		}

	}

	dispose() {

		if ( this.domElement !== null ) {

			this.domElement.remove();

		}

		this._parent = null;
		this._signature = '';

	}

}

export { DebugViewLegend, getLegendSpec, wrapDebugConfigForLegend };
