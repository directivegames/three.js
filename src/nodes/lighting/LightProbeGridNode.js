import LightingNode from './LightingNode.js';
import { normalWorld } from '../accessors/Normal.js';
import { positionWorld } from '../accessors/Position.js';
import { texture3D } from '../accessors/Texture3DNode.js';
import { NodeUpdateType } from '../core/constants.js';
import { uniform } from '../core/UniformNode.js';
import getLightProbeGridIrradiance from '../functions/material/getLightProbeGridIrradiance.js';
import { FloatType, LinearFilter, RGBAFormat } from '../../constants.js';
import { Data3DTexture } from '../../textures/Data3DTexture.js';
import { Vector3 } from '../../math/Vector3.js';

const _objectPosition = /*@__PURE__*/ new Vector3();
const _emptyTexture = /*@__PURE__*/ new Data3DTexture( new Float32Array( 1 * 1 * 28 * 4 ), 1, 1, 28 );

_emptyTexture.format = RGBAFormat;
_emptyTexture.type = FloatType;
_emptyTexture.minFilter = LinearFilter;
_emptyTexture.magFilter = LinearFilter;
_emptyTexture.needsUpdate = true;

function findLightProbeGrid( volumes, object ) {

	if ( volumes.length === 0 ) return null;

	if ( volumes.length === 1 ) {

		return volumes[ 0 ].texture !== null ? volumes[ 0 ] : null;

	}

	_objectPosition.setFromMatrixPosition( object.matrixWorld );

	for ( let i = 0, l = volumes.length; i < l; i ++ ) {

		const volume = volumes[ i ];

		if ( volume.texture !== null && volume.boundingBox.containsPoint( _objectPosition ) ) return volume;

	}

	return null;

}

/**
 * Adds diffuse irradiance from the active LightProbeGrid to WebGPU node materials.
 *
 * @augments LightingNode
 */
class LightProbeGridNode extends LightingNode {

	static get type() {

		return 'LightProbeGridNode';

	}

	/**
	 * Constructs a new light probe grid node.
	 *
	 * @param {Array<Object3D>} [lightProbeGrids=[]] - Light probe grids collected from the scene.
	 */
	constructor( lightProbeGrids = [] ) {

		super();

		this.lightProbeGrids = lightProbeGrids;
		this.activeLightProbeGrid = null;

		this.probesSH = texture3D( _emptyTexture );
		this.probesMin = uniform( new Vector3() );
		this.probesMax = uniform( new Vector3( 1, 1, 1 ) );
		this.probesResolution = uniform( new Vector3( 2, 2, 2 ) );

		this.updateType = NodeUpdateType.OBJECT;

	}

	update( frame ) {

		const activeLightProbeGrid = findLightProbeGrid( this.lightProbeGrids, frame.object );

		this.activeLightProbeGrid = activeLightProbeGrid;

		if ( activeLightProbeGrid !== null ) {

			activeLightProbeGrid.updateBoundingBox();

			this.probesSH.value = activeLightProbeGrid.texture;
			this.probesMin.value.copy( activeLightProbeGrid.boundingBox.min );
			this.probesMax.value.copy( activeLightProbeGrid.boundingBox.max );
			this.probesResolution.value.copy( activeLightProbeGrid.resolution );

		} else {

			this.probesSH.value = _emptyTexture;
			this.probesMin.value.set( 0, 0, 0 );
			this.probesMax.value.set( 1, 1, 1 );
			this.probesResolution.value.set( 2, 2, 2 );

		}

	}

	setup( builder ) {

		const irradiance = getLightProbeGridIrradiance( {
			probesSH: this.probesSH,
			probesMin: this.probesMin,
			probesMax: this.probesMax,
			probesResolution: this.probesResolution,
			worldPosition: positionWorld,
			worldNormal: normalWorld
		} );

		builder.context.irradiance.addAssign( irradiance );

	}

	getHash() {

		return `lightProbeGrid-${ this.lightProbeGrids.map( ( lightProbeGrid ) => lightProbeGrid.id ).join( ',' ) }`;

	}

}

export default LightProbeGridNode;
