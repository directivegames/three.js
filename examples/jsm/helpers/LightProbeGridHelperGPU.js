import {
	Data3DTexture,
	FloatType,
	InstancedBufferAttribute,
	InstancedMesh,
	LinearFilter,
	Matrix4,
	NodeMaterial,
	RGBAFormat,
	SphereGeometry,
	Vector3
} from 'three/webgpu';
import {
	attribute,
	Fn,
	getLightProbeGridIrradianceAtUV,
	normalWorld,
	texture3D,
	uniform,
	vec4
} from 'three/tsl';

const _emptyTexture = /*@__PURE__*/ new Data3DTexture( new Float32Array( 1 * 1 * 28 * 4 ), 1, 1, 28 );

_emptyTexture.format = RGBAFormat;
_emptyTexture.type = FloatType;
_emptyTexture.minFilter = LinearFilter;
_emptyTexture.magFilter = LinearFilter;
_emptyTexture.needsUpdate = true;

/**
 * Visualizes a {@link LightProbeGrid} with a WebGPU-compatible node material.
 *
 * ```js
 * const helper = new LightProbeGridHelper( probes );
 * scene.add( helper );
 * ```
 *
 * @augments InstancedMesh
 * @three_import import { LightProbeGridHelper } from 'three/addons/helpers/LightProbeGridHelperGPU.js';
 */
class LightProbeGridHelper extends InstancedMesh {

	/**
	 * Constructs a new irradiance probe grid helper.
	 *
	 * @param {LightProbeGrid} probes - The probe grid to visualize.
	 * @param {number} [sphereSize=0.12] - The radius of each probe sphere.
	 */
	constructor( probes, sphereSize = 0.12 ) {

		const geometry = new SphereGeometry( sphereSize, 16, 16 );
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

		const res = probes.resolution;
		const count = res.x * res.y * res.z;

		super( geometry, material, count );

		/**
		 * The probe grid to visualize.
		 *
		 * @type {LightProbeGrid}
		 */
		this.probes = probes;

		this.type = 'LightProbeGridHelper';

		this._probesSH = probesSH;
		this._probesResolution = probesResolution;

		this.update();

	}

	/**
	 * Rebuilds instance matrices and UVW attributes from the current probe grid.
	 */
	update() {

		const probes = this.probes;
		const res = probes.resolution;
		const count = res.x * res.y * res.z;

		if ( this.instanceMatrix.count !== count ) {

			this.instanceMatrix.dispose();
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

			if ( instanceUVW !== undefined ) {

				instanceUVW.dispose();

			}

			const uvwArray = new Float32Array( count * 3 );

			i = 0;

			for ( let iz = 0; iz < res.z; iz ++ ) {

				for ( let iy = 0; iy < res.y; iy ++ ) {

					for ( let ix = 0; ix < res.x; ix ++ ) {

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

		this._probesSH.value = probes.texture || _emptyTexture;
		this._probesResolution.value.copy( probes.resolution );

	}

	/**
	 * Frees the GPU-related resources allocated by this instance.
	 */
	dispose() {

		this.instanceMatrix.dispose();

		const instanceUVW = this.geometry.getAttribute( 'instanceUVW' );

		if ( instanceUVW !== undefined ) {

			instanceUVW.dispose();

		}

		this.geometry.dispose();
		this.material.dispose();

	}

}

export { LightProbeGridHelper };
