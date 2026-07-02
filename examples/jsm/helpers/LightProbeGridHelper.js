import {
	Data3DTexture,
	FloatType,
	InstancedBufferAttribute,
	InstancedMesh,
	LinearFilter,
	Matrix4,
	RGBAFormat,
	ShaderMaterial,
	SphereGeometry,
	Vector3
} from 'three';
// WITH_GENESYS
import { NodeMaterial } from 'three/webgpu';
import {
	attribute,
	Fn,
	getLightProbeGridIrradianceAtUV,
	normalWorld,
	texture3D,
	uniform,
	vec4
} from 'three/tsl';
// !WITH_GENESYS

// WITH_GENESYS
const _emptyTexture = /*@__PURE__*/ new Data3DTexture( new Float32Array( 1 * 1 * 28 * 4 ), 1, 1, 28 );

_emptyTexture.format = RGBAFormat;
_emptyTexture.type = FloatType;
_emptyTexture.minFilter = LinearFilter;
_emptyTexture.magFilter = LinearFilter;
_emptyTexture.needsUpdate = true;

function createNodeMaterial( probes ) {

	const probesSH = texture3D( probes.texture || _emptyTexture );
	const probesResolution = uniform( new Vector3( 1, 1, 1 ) );
	const instanceUVW = attribute( 'instanceUVW', 'vec3' );

	const fragmentNode = Fn( () => {

		const irradiance = getLightProbeGridIrradianceAtUV( {
			probesSH,
			probesResolution,
			gridUVW: instanceUVW,
			worldNormal: normalWorld
		} );

		return vec4( irradiance, 1.0 );

	} )();

	const material = new NodeMaterial();
	material.fragmentNode = fragmentNode;

	return { material, probesSH, probesResolution };

}
// !WITH_GENESYS

function createShaderMaterial() {

	return new ShaderMaterial( {

		uniforms: {

			probesSH: { value: null },
			probesResolution: { value: new Vector3() },

		},

		vertexShader: /* glsl */`

			attribute vec3 instanceUVW;

			varying vec3 vWorldNormal;
			varying vec3 vUVW;

			void main() {

				vUVW = instanceUVW;
				vWorldNormal = normalize( mat3( modelMatrix ) * normal );
				gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );

			}

		`,

		fragmentShader: /* glsl */`

			precision highp sampler3D;

			uniform sampler3D probesSH;
			uniform vec3 probesResolution;

			varying vec3 vWorldNormal;
			varying vec3 vUVW;

			void main() {

				// Atlas UV mapping — must match lightprobes_pars_fragment.glsl.js
				float nz          = probesResolution.z;
				float paddedSlices = nz + 2.0;
				float atlasDepth  = 7.0 * paddedSlices;
				float uvZBase     = vUVW.z * nz + 1.0;

				vec4 s0 = texture( probesSH, vec3( vUVW.xy, ( uvZBase                       ) / atlasDepth ) );
				vec4 s1 = texture( probesSH, vec3( vUVW.xy, ( uvZBase +       paddedSlices   ) / atlasDepth ) );
				vec4 s2 = texture( probesSH, vec3( vUVW.xy, ( uvZBase + 2.0 * paddedSlices   ) / atlasDepth ) );
				vec4 s3 = texture( probesSH, vec3( vUVW.xy, ( uvZBase + 3.0 * paddedSlices   ) / atlasDepth ) );
				vec4 s4 = texture( probesSH, vec3( vUVW.xy, ( uvZBase + 4.0 * paddedSlices   ) / atlasDepth ) );
				vec4 s5 = texture( probesSH, vec3( vUVW.xy, ( uvZBase + 5.0 * paddedSlices   ) / atlasDepth ) );
				vec4 s6 = texture( probesSH, vec3( vUVW.xy, ( uvZBase + 6.0 * paddedSlices   ) / atlasDepth ) );

				// Unpack 9 vec3 SH L2 coefficients

				vec3 c0 = s0.xyz;
				vec3 c1 = vec3( s0.w, s1.xy );
				vec3 c2 = vec3( s1.zw, s2.x );
				vec3 c3 = s2.yzw;
				vec3 c4 = s3.xyz;
				vec3 c5 = vec3( s3.w, s4.xy );
				vec3 c6 = vec3( s4.zw, s5.x );
				vec3 c7 = s5.yzw;
				vec3 c8 = s6.xyz;

				vec3 n = normalize( vWorldNormal );

				float x = n.x, y = n.y, z = n.z;

				// band 0
				vec3 result = c0 * 0.886227;

				// band 1,
				result += c1 * 2.0 * 0.511664 * y;
				result += c2 * 2.0 * 0.511664 * z;
				result += c3 * 2.0 * 0.511664 * x;

				// band 2,
				result += c4 * 2.0 * 0.429043 * x * y;
				result += c5 * 2.0 * 0.429043 * y * z;
				result += c6 * ( 0.743125 * z * z - 0.247708 );
				result += c7 * 2.0 * 0.429043 * x * z;
				result += c8 * 0.429043 * ( x * x - y * y );

				gl_FragColor = vec4( max( result, vec3( 0.0 ) ), 1.0 );

				#include <tonemapping_fragment>
				#include <colorspace_fragment>

			}

		`

	} );

}

/**
 * Visualizes an {@link LightProbeGrid} by rendering a sphere at each
 * probe position, shaded with the probe's L2 spherical harmonics.
 *
 * Uses a single `InstancedMesh` draw call for all probes.
 *
 * ```js
 * const helper = new LightProbeGridHelper( probes );
 * scene.add( helper );
 * ```
 *
 * @augments InstancedMesh
 * @three_import import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelper.js';
 */
class LightProbeGridHelper extends InstancedMesh {

	/**
	 * Constructs a new irradiance probe grid helper.
	 *
	 * @param {LightProbeGrid} probes - The probe grid to visualize.
	 * @param {number} [sphereSize=0.12] - The radius of each probe sphere.
	 * @param {Object} [options] - The helper options.
	 * @param {boolean} [options.webgpu=false] - Whether to use a WebGPU-compatible node material.
	 */
	constructor( probes, sphereSize = 0.12, options = {} ) {

		const geometry = new SphereGeometry( sphereSize, 16, 16 );
		const materialState = options.webgpu === true ? createNodeMaterial( probes ) : { material: createShaderMaterial() };

		const res = probes.resolution;
		const count = res.x * res.y * res.z;

		super( geometry, materialState.material, count );

		/**
		 * The probe grid to visualize.
		 *
		 * @type {LightProbeGrid}
		 */
		this.probes = probes;

		this.type = 'LightProbeGridHelper';

		// WITH_GENESYS
		this._probesSH = materialState.probesSH || null;
		this._probesResolution = materialState.probesResolution || null;
		// !WITH_GENESYS

		this.update();

	}

	/**
	 * Rebuilds instance matrices and UVW attributes from the current probe grid.
	 * Call this after changing `probes` or after re-baking.
	 */
	update() {

		const probes = this.probes;
		const res = probes.resolution;
		const count = res.x * res.y * res.z;

		if ( this.instanceMatrix.count !== count ) {

			// WITH_GENESYS
			this.instanceMatrix.dispose();
			// !WITH_GENESYS
			this.instanceMatrix = new InstancedBufferAttribute( new Float32Array( count * 16 ), 16 );

		}

		this.count = count;

		const matrix = new Matrix4();
		const probePos = new Vector3();

		let i = 0;

		for ( let iz = 0; iz < res.z; iz ++ ) {

			for ( let iy = 0; iy < res.y; iy ++ ) {

				for ( let ix = 0; ix < res.x; ix ++ ) {

					probes.getProbePosition( ix, iy, iz, probePos );
					matrix.makeTranslation( probePos.x, probePos.y, probePos.z );
					this.setMatrixAt( i, matrix );

					i ++;

				}

			}

		}

		this.instanceMatrix.needsUpdate = true;

		let instanceUVW = this.geometry.getAttribute( 'instanceUVW' );

		if ( instanceUVW === undefined || instanceUVW.count !== count ) {

			// WITH_GENESYS
			if ( instanceUVW !== undefined ) {

				instanceUVW.dispose();

			}
			// !WITH_GENESYS

			const uvwArray = new Float32Array( count * 3 );

			i = 0;

			for ( let iz = 0; iz < res.z; iz ++ ) {

				for ( let iy = 0; iy < res.y; iy ++ ) {

					for ( let ix = 0; ix < res.x; ix ++ ) {

						// Remap to texel centers (must match lightprobes_pars_fragment.glsl.js)
						uvwArray[ i * 3 ] = ( ix + 0.5 ) / res.x;
						uvwArray[ i * 3 + 1 ] = ( iy + 0.5 ) / res.y;
						uvwArray[ i * 3 + 2 ] = ( iz + 0.5 ) / res.z;

						i ++;

					}

				}

			}

			instanceUVW = new InstancedBufferAttribute( uvwArray, 3 );
			this.geometry.setAttribute( 'instanceUVW', instanceUVW );

		}

		// Update texture uniforms

		// WITH_GENESYS
		if ( this._probesSH !== null && this._probesResolution !== null ) {

			this._probesSH.value = probes.texture || _emptyTexture;
			this._probesResolution.value.copy( probes.resolution );

		} else {

			// !WITH_GENESYS

			this.material.uniforms.probesSH.value = probes.texture;
			this.material.uniforms.probesResolution.value.copy( probes.resolution );

			// WITH_GENESYS

		}
		// !WITH_GENESYS

	}

	/**
	 * Frees the GPU-related resources allocated by this instance. Call this
	 * method whenever this instance is no longer used in your app.
	 */
	dispose() {

		// WITH_GENESYS
		this.instanceMatrix.dispose();

		const instanceUVW = this.geometry.getAttribute( 'instanceUVW' );

		if ( instanceUVW !== undefined ) {

			instanceUVW.dispose();

		}
		// !WITH_GENESYS

		this.geometry.dispose();
		this.material.dispose();

	}

}

export { LightProbeGridHelper };
