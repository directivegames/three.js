import { Parameters } from './Parameters.js';
import { WebGPURenderer, WebGLBackend, Node } from 'three/webgpu';
import { getItem, setItem } from '../Inspector.js';

const _extensions = [
	{
		name: 'Color Grading',
		url: '../extensions/color-grading/ColorGrading.js'
	},
	{
		name: 'TSL Graph',
		url: '../extensions/tsl-graph/TSLGraphEditor.js'
	}
];

const _init = WebGPURenderer.prototype.init;

function forceWebGL( enable ) {

	if ( enable ) {

		WebGPURenderer.prototype.init = async function () {

			if ( this.backend.isWebGLBackend !== true ) {

				const parameters = this.backend.parameters;

				this.backend = new WebGLBackend( parameters );

			}

			return _init.call( this );

		};

	} else {

		WebGPURenderer.prototype.init = _init;

	}

}

let _state = null;

function _loadState() {

	if ( _state !== null ) return _state;

	const settings = getItem( 'settings' );

	_state = {
		forceWebGL: settings.forceWebGL !== undefined ? settings.forceWebGL : false,
		captureStackTrace: settings.captureStackTrace !== undefined ? settings.captureStackTrace : false,
		activeExtensions: settings.activeExtensions !== undefined ? settings.activeExtensions : {},
		storage: settings.storage !== undefined ? settings.storage : 'url'
	};

	if ( _state.forceWebGL ) {

		forceWebGL( true );

	}

	if ( _state.captureStackTrace ) {

		Node.captureStackTrace = true;

	}

	return _state;

}

function _saveState() {

	setItem( 'settings', {
		forceWebGL: _state.forceWebGL,
		captureStackTrace: _state.captureStackTrace,
		activeExtensions: _state.activeExtensions,
		storage: _state.storage
	} );

}

// WITH_GENESYS
// Defer state load until Settings is instantiated. Calling `_loadState()` at
// module evaluation time triggers `Inspector.getItem()`, which reads `REVISION`
// (imported from `three/webgpu`) while `Inspector.js` is still mid-evaluation (TDZ).
// _loadState();
// !WITH_GENESYS

//

class Settings extends Parameters {

	constructor() {

		super( { name: 'Settings' } );

		this.extensions = {};

		const currentState = _loadState();

		// UI

		const rendererGroup = this.createGroup( 'Renderer' );

		rendererGroup.add( currentState, 'forceWebGL' ).name( 'Force WebGL' ).onChange( ( enable ) => {

			forceWebGL( enable );
			_saveState();

			location.reload();

		} );

		rendererGroup.add( currentState, 'captureStackTrace' ).name( 'Capture Stack Trace' ).onChange( ( enable ) => {

			Node.captureStackTrace = enable;
			_saveState();

			location.reload();

		} );

		// Render Modes

		const modesGroup = this.createGroup( 'Render Modes' );

		modesGroup.add( { overdraw: false }, 'overdraw' ).name( 'Overdraw' ).onChange( ( enable ) => {

			this.inspector.overdraw = enable;

		} ).info( 'Shows how many times each pixel is shaded.' );

		// WITH_GENESYS
		// Values match Renderer.debug.view. Not stored with inspector settings.
		const debugViewState = { view: 'none' };
		const bufferState = { buffer: 'baseColor' };

		this._debugViewState = debugViewState;
		this._bufferState = bufferState;
		this._debugViewControl = modesGroup.add( debugViewState, 'view', {
			'Shaded': 'none',
			'Shader Complexity': 'shaderComplexity',
			'Lighting Complexity': 'lightingComplexity',
			'Overdraw': 'overdraw',
			'Shader Complexity & Quads': 'shaderComplexityAndQuads',
			'Buffer Visualization': 'bufferVisualization',
			'Lighting Only': 'lightingOnly',
			'Detail Lighting': 'detailLighting',
			'Draw Call': 'drawCall'
		} ).name( 'Debug View' ).onChange( ( view ) => {

			const renderer = this.inspector.getRenderer();

			if ( renderer === null || renderer.debug === undefined ) return;

			renderer.debug.view = view;
			this._syncBufferRow( view );
			window.dispatchEvent( new Event( 'genesys-debug-view' ) );

		} ).info( 'Shaded color, a cost heatmap, per-pixel overdraw, shader cost times overdraw, one material channel, lighting on a flat gray surface, or one lit color per draw. The Overdraw toggle above draws on top when both are enabled.' );

		this._bufferControl = modesGroup.add( bufferState, 'buffer', {
			'Base Color': 'baseColor',
			'World Normal': 'worldNormal',
			'Roughness': 'roughness',
			'Metallic': 'metallic',
			'Ambient Occlusion': 'ambientOcclusion',
			'Emissive': 'emissive'
		} ).name( 'Buffer' ).onChange( ( buffer ) => {

			const renderer = this.inspector.getRenderer();

			if ( renderer === null || renderer.debug === undefined ) return;

			renderer.debug.buffer = buffer;
			window.dispatchEvent( new Event( 'genesys-debug-view' ) );

		} ).info( 'Channel drawn by Buffer Visualization. Base color, world normal, roughness, metallic, ambient occlusion, or emissive.' );

		this._bufferControl.hide();
		// !WITH_GENESYS

	}

	init() {

		// WITH_GENESYS
		const renderer = this.inspector.getRenderer();
		const view = renderer !== null && renderer.debug !== undefined ? renderer.debug.view : null;

		if ( view === 'none' || view === 'shaderComplexity' || view === 'lightingComplexity' || view === 'overdraw' || view === 'shaderComplexityAndQuads' || view === 'bufferVisualization' || view === 'lightingOnly' || view === 'detailLighting' || view === 'drawCall' ) {

			if ( this._debugViewState.view !== view ) {

				this._debugViewControl.setValue( view );

			}

			this._syncBufferRow( view );

		}

		const buffer = renderer !== null && renderer.debug !== undefined ? renderer.debug.buffer : null;
		const buffers = [ 'baseColor', 'worldNormal', 'roughness', 'metallic', 'ambientOcclusion', 'emissive' ];

		if ( buffers.includes( buffer ) && this._bufferState.buffer !== buffer ) {

			this._bufferControl.setValue( buffer );

		}
		// !WITH_GENESYS

		const extensionsGroup = this.createGroup( 'Extensions' );

		const storageGroup = this.createGroup( 'Storage' );

		const currentState = _loadState();

		storageGroup.add( currentState, 'storage', { 'URL Session': 'url', 'Keep across Origin': 'origin' } )
			.name( 'Save Settings' )
			.onChange( () => {

				_saveState();

			} ).info( `
Defines how the **Inspector** preferences and states are stored in the browser.

**URL Session**
Saves state based on the exact URL. It will reset the settings whenever the URL changes.

**Keep across Origin**
Shares the same state across any page within the current origin.` );

		storageGroup.add( {
			clear: () => {

				localStorage.removeItem( 'threejs-inspector' );

				location.reload();

			}
		}, 'clear' ).name( 'Clear Settings' );

		this._getExtensions().then( extensions => {

			for ( const extension of extensions ) {

				extension.active = false;
				extension.loaded = false;
				extension.tab = null;

				this.extensions[ extension.name ] = extension;

				extension.ui = extensionsGroup.add( { [ extension.name ]: false }, extension.name ).onChange( async ( value ) => {

					this.setActiveExtension( extension.name, value );

					// User preference

					if ( value ) {

						_state.activeExtensions[ extension.name ] = {
							name: extension.name,
							url: extension.url
						};

					} else {

						delete _state.activeExtensions[ extension.name ];


					}

					//

					this._updateExtensionUI( extension );

					_saveState();

				} );

				// Set user-defined state

				if ( _state.activeExtensions[ extension.name ] !== undefined ) {

					extension.ui.setValue( true );

				}

			}

		} );

	}

	// WITH_GENESYS
	/**
	 * Shows the buffer channel row only while buffer visualization is the debug view.
	 *
	 * @param {string} view - `renderer.debug.view`.
	 */
	_syncBufferRow( view ) {

		if ( view === 'bufferVisualization' ) {

			this._bufferControl.show();

		} else {

			this._bufferControl.hide();

		}

	}
	// !WITH_GENESYS

	async setActiveExtension( name, value ) {

		const extension = this.extensions[ name ];
		const inspector = this.inspector;

		if ( extension ) {

			if ( value ) {

				await this._loadExtension( inspector, extension );

			} else {

				await this._unloadExtension( inspector, extension );

			}

		}

	}

	_updateExtensionUI( extension ) {

		const forceActive = extension.active && _state.activeExtensions[ extension.name ] === undefined;

		if ( forceActive ) {

			extension.ui.checkbox.checked = true;
			extension.ui.domElement.style.setProperty( '--accent-color', 'var(--color-green)' );

		} else {

			extension.ui.domElement.style.removeProperty( '--accent-color' );

		}

	}

	async _unloadExtension( inspector, extension ) {

		if ( extension.active === false ) return;

		//

		inspector.removeTab( extension.tab );

		extension.active = false;
		extension.loaded = false;
		extension.tab = null;

		this._updateExtensionUI( extension );

		this.dispatchEvent( { type: 'extensionremoved', name: extension.name } );

	}

	async _loadExtension( inspector, extension ) {

		if ( extension.active === true ) return;

		//

		extension.active = true;

		// WITH_GENESYS
		// `new URL( extension.url, import.meta.url )` fails with webpack 5 because the
		// first argument is dynamic ("Can't resolve <dynamic>"). With @vite-ignore and
		// webpackIgnore, the browser resolves the relative `extension.url` at runtime.
		const module = await import( /* @vite-ignore */ /* webpackIgnore: true */ extension.url );
		// !WITH_GENESYS

		const keys = Object.keys( module );
		const ExtensionClass = module[ keys[ 0 ] ];
		const extensionTab = new ExtensionClass();

		inspector.addTab( extensionTab );

		extension.loaded = true;
		extension.tab = extensionTab;

		this._updateExtensionUI( extension );

		this.dispatchEvent( { type: 'extensionadded', name: extension.name, tab: extensionTab } );

	}

	async _getExtensions() {

		return _extensions;

	}

}

export { Settings };
