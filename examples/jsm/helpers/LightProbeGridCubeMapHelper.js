import {
	BoxGeometry,
	Mesh,
	Object3D,
	ShaderMaterial,
	Vector3
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
	cubeTexture,
	Fn,
	normalWorld,
	vec4
} from 'three/tsl';

function createNodeMaterial( texture ) {

	const fragmentNode = Fn( () => {

		return vec4( cubeTexture( texture, normalWorld ).rgb, 1.0 );

	} )();

	const material = new NodeMaterial();
	material.fragmentNode = fragmentNode;

	return material;

}

function createShaderMaterial( texture ) {

	return new ShaderMaterial( {

		uniforms: {

			cubeTexture: { value: texture }

		},

		vertexShader: /* glsl */`

			varying vec3 vWorldNormal;

			void main() {

				vWorldNormal = normalize( mat3( modelMatrix ) * normal );
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

			}

		`,

		fragmentShader: /* glsl */`

			precision highp float;

			uniform samplerCube cubeTexture;

			varying vec3 vWorldNormal;

			void main() {

				vec3 direction = normalize( vWorldNormal );
				vec3 color = textureCube( cubeTexture, direction ).rgb;

				gl_FragColor = vec4( color, 1.0 );

				#include <tonemapping_fragment>
				#include <colorspace_fragment>

			}

		`

	} );

}

/**
 * Visualizes an {@link LightProbeGrid} by rendering a cube at each
 * probe position, displaying the captured cube map on each face.
 *
 * Requires the probe grid to be baked with `retainCubemaps: true` option.
 *
 * ```js
 * // First bake with retainCubemaps option
 * await probeGrid.bake( renderer, scene, { retainCubemaps: true } );
 *
 * // Then create the helper
 * const helper = new LightProbeGridCubeMapHelper( probeGrid );
 * scene.add( helper );
 * ```
 *
 * @augments Object3D
 * @three_import import { LightProbeGridCubeMapHelper } from 'three/addons/helpers/LightProbeGridCubeMapHelper.js';
 */
class LightProbeGridCubeMapHelper extends Object3D {

	/**
	 * Constructs a new light probe grid cube map helper.
	 *
	 * @param {LightProbeGrid} probes - The probe grid to visualize.
	 * @param {number} [cubeSize=0.15] - The size of each probe cube.
	 * @param {Object} [options] - The helper options.
	 * @param {boolean} [options.webgpu=false] - Whether to use a WebGPU-compatible node material.
	 */
	constructor( probes, cubeSize = 0.15, options = {} ) {

		super();

		/**
		 * The probe grid to visualize.
		 *
		 * @type {LightProbeGrid}
		 */
		this.probes = probes;

		this.type = 'LightProbeGridCubeMapHelper';

		/**
		 * The size of each probe cube.
		 *
		 * @type {number}
		 */
		this.cubeSize = cubeSize;

		/**
		 * Whether to use WebGPU node materials.
		 *
		 * @private
		 * @type {boolean}
		 */
		this._webgpu = options.webgpu === true;

		/**
		 * Shared cube geometry.
		 *
		 * @private
		 * @type {BoxGeometry}
		 */
		this._geometry = new BoxGeometry( cubeSize, cubeSize, cubeSize );

		this.update();

	}

	/**
	 * Rebuilds cube meshes from the current probe grid.
	 * Call this after changing `probes` or after re-baking with `retainCubemaps: true`.
	 */
	update() {

		this._clearCubes();

		const probes = this.probes;
		const res = probes.resolution;
		const cubeTextures = probes.cubeTextures || [];
		const probePos = new Vector3();

		let i = 0;

		for ( let iz = 0; iz < res.z; iz ++ ) {

			for ( let iy = 0; iy < res.y; iy ++ ) {

				for ( let ix = 0; ix < res.x; ix ++ ) {

					const texture = cubeTextures[ i ];

					if ( texture !== undefined ) {

						const material = this._webgpu === true ? createNodeMaterial( texture ) : createShaderMaterial( texture );
						const cube = new Mesh( this._geometry, material );

						probes.getProbePosition( ix, iy, iz, probePos );
						cube.position.copy( probePos );
						this.add( cube );

					}

					i ++;

				}

			}

		}

	}

	/**
	 * Frees the GPU-related resources allocated by this instance. Call this
	 * method whenever this instance is no longer used in your app.
	 */
	dispose() {

		this._clearCubes();
		this._geometry.dispose();

	}

	/**
	 * Removes all cube children and disposes their materials.
	 *
	 * @private
	 */
	_clearCubes() {

		for ( const child of this.children ) {

			child.material.dispose();

		}

		this.clear();

	}

}

export { LightProbeGridCubeMapHelper };
