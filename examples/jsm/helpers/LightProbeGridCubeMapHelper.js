import {
	BoxGeometry,
	Mesh,
	Object3D,
	ShaderMaterial,
	Vector3
} from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
	abs,
	cubeTexture,
	Fn,
	max,
	normalLocal,
	positionLocal,
	select,
	vec3,
	vec4
} from 'three/tsl';

function createNodeMaterial( texture ) {

	const fragmentNode = Fn( () => {

		// Get local position and normal
		const localPos = positionLocal;
		const localNormal = normalLocal;

		// Get absolute normal components to determine dominant axis
		const absNormal = abs( localNormal );
		const maxComp = max( max( absNormal.x, absNormal.y ), absNormal.z );

		// Determine which face we're on and compute sample direction
		const isX = maxComp.equal( absNormal.x );
		const isY = maxComp.equal( absNormal.y ).and( isX.not() );

		// Match LightProbeGrid / WebGL cubemap face conventions (see LightProbeGrid.js SH projection).
		const xPositive = localNormal.x.greaterThan( 0.0 );
		const xDir = select( xPositive,
			vec3( 1.0, localPos.y, localPos.z.negate() ).normalize(),
			vec3( - 1.0, localPos.y, localPos.z ).normalize()
		);

		const yPositive = localNormal.y.greaterThan( 0.0 );
		const yDir = select( yPositive,
			vec3( localPos.x, 1.0, localPos.z.negate() ).normalize(),
			vec3( localPos.x, - 1.0, localPos.z ).normalize()
		);

		const zPositive = localNormal.z.greaterThan( 0.0 );
		const zDir = select( zPositive,
			vec3( localPos.x, localPos.y, 1.0 ).normalize(),
			vec3( localPos.x, localPos.y, - 1.0 ).normalize()
		);

		// Select the appropriate direction based on which axis is dominant
		const sampleDir = select( isX, xDir, select( isY, yDir, zDir ) );

		return vec4( cubeTexture( texture, sampleDir ).rgb, 1.0 );

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

			varying vec3 vLocalPosition;
			varying vec3 vNormal;

			void main() {

				vLocalPosition = position;
				vNormal = normal;
				gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

			}

		`,

		fragmentShader: /* glsl */`

			precision highp float;

			uniform samplerCube cubeTexture;

			varying vec3 vLocalPosition;
			varying vec3 vNormal;

			void main() {
				// Get the dominant axis from the normal to determine which face we're on
				vec3 absNormal = abs( vNormal );
				float maxComp = max( max( absNormal.x, absNormal.y ), absNormal.z );

				vec3 sampleDir;

				// Match LightProbeGrid / WebGL cubemap face conventions (see LightProbeGrid.js SH projection).
				if ( maxComp == absNormal.x ) {

					if ( vNormal.x > 0.0 ) {

						sampleDir = normalize( vec3( 1.0, vLocalPosition.y, -vLocalPosition.z ) );

					} else {

						sampleDir = normalize( vec3( -1.0, vLocalPosition.y, vLocalPosition.z ) );

					}

				} else if ( maxComp == absNormal.y ) {

					if ( vNormal.y > 0.0 ) {

						sampleDir = normalize( vec3( vLocalPosition.x, 1.0, -vLocalPosition.z ) );

					} else {

						sampleDir = normalize( vec3( vLocalPosition.x, -1.0, vLocalPosition.z ) );

					}

				} else {

					if ( vNormal.z > 0.0 ) {

						sampleDir = normalize( vec3( vLocalPosition.x, vLocalPosition.y, 1.0 ) );

					} else {

						sampleDir = normalize( vec3( vLocalPosition.x, vLocalPosition.y, -1.0 ) );

					}

				}

				vec3 color = textureCube( cubeTexture, sampleDir ).rgb;

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
