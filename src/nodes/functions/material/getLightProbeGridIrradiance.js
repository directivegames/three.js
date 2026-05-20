import { Fn, max, vec3 } from '../../tsl/TSLBase.js';

export const getLightProbeGridIrradianceAtUV = /*@__PURE__*/ Fn( ( { probesSH, probesResolution, gridUVW, worldNormal } ) => {

	const res = probesResolution;
	const uvw = gridUVW.toVar();

	const nz = res.z;
	const paddedSlices = nz.add( 2.0 );
	const atlasDepth = paddedSlices.mul( 7.0 );
	const uvZBase = uvw.z.mul( nz ).add( 1.0 );

	const atlasUv = ( sliceOffset ) => vec3( uvw.x, uvw.y, uvZBase.add( paddedSlices.mul( sliceOffset ) ).div( atlasDepth ) );

	const s0 = probesSH.sample( atlasUv( 0.0 ) );
	const s1 = probesSH.sample( atlasUv( 1.0 ) );
	const s2 = probesSH.sample( atlasUv( 2.0 ) );
	const s3 = probesSH.sample( atlasUv( 3.0 ) );
	const s4 = probesSH.sample( atlasUv( 4.0 ) );
	const s5 = probesSH.sample( atlasUv( 5.0 ) );
	const s6 = probesSH.sample( atlasUv( 6.0 ) );

	const c0 = s0.xyz;
	const c1 = vec3( s0.w, s1.x, s1.y );
	const c2 = vec3( s1.z, s1.w, s2.x );
	const c3 = s2.yzw;
	const c4 = s3.xyz;
	const c5 = vec3( s3.w, s4.x, s4.y );
	const c6 = vec3( s4.z, s4.w, s5.x );
	const c7 = s5.yzw;
	const c8 = s6.xyz;

	const x = worldNormal.x, y = worldNormal.y, z = worldNormal.z;

	let result = c0.mul( 0.886227 );
	result = result.add( c1.mul( 2.0 * 0.511664 ).mul( y ) );
	result = result.add( c2.mul( 2.0 * 0.511664 ).mul( z ) );
	result = result.add( c3.mul( 2.0 * 0.511664 ).mul( x ) );
	result = result.add( c4.mul( 2.0 * 0.429043 ).mul( x ).mul( y ) );
	result = result.add( c5.mul( 2.0 * 0.429043 ).mul( y ).mul( z ) );
	result = result.add( c6.mul( z.mul( z ).mul( 0.743125 ).sub( 0.247708 ) ) );
	result = result.add( c7.mul( 2.0 * 0.429043 ).mul( x ).mul( z ) );
	result = result.add( c8.mul( 0.429043 ).mul( x.mul( x ).sub( y.mul( y ) ) ) );

	return max( result, vec3( 0.0 ) );

} );

const getLightProbeGridIrradiance = /*@__PURE__*/ Fn( ( { probesSH, probesMin, probesMax, probesResolution, worldPosition, worldNormal } ) => {

	const res = probesResolution;
	const gridRange = probesMax.sub( probesMin ).toVar();
	const resMinusOne = res.sub( 1.0 );
	const probeSpacing = gridRange.div( resMinusOne ).toVar();

	const samplePos = worldPosition.add( worldNormal.mul( probeSpacing ).mul( 0.5 ) );
	const gridUVW = samplePos.sub( probesMin ).div( gridRange ).clamp( 0.0, 1.0 ).mul( resMinusOne.div( res ) ).add( vec3( 0.5 ).div( res ) );

	return getLightProbeGridIrradianceAtUV( {
		probesSH,
		probesResolution,
		gridUVW,
		worldNormal
	} );

} );

export default getLightProbeGridIrradiance;
