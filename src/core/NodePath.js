// WITH_GENESYS
/**
 * Path of sibling-local nodeIds identifying a node in the scene tree.
 * String form: `"a1b2/c3d4"` (4-hex segments separated by `/`).
 */

import { isValidNodeId, nodeIdFromString, nodeIdToString } from './nodeId.js';

class NodePath {

	/**
	 * @param {readonly number[]} [ids]
	 */
	constructor( ids = [] ) {

		const normalized = [];
		for ( const id of ids ) {

			if ( ! isValidNodeId( id ) ) {

				throw new Error( `[NodePath] Invalid NodeId segment: ${ String( id ) }` );

			}

			normalized.push( id & 0xffff );

		}

		this.ids = normalized;

	}

	/**
	 * @param {...number} ids
	 * @return {NodePath}
	 */
	static fromIds( ...ids ) {

		return new NodePath( ids );

	}

	/**
	 * Parses `"a1b2/c3d4"`. Empty / whitespace-only string yields {@link NodePath.empty}.
	 * @param {string} path
	 * @return {NodePath}
	 */
	static fromString( path ) {

		const trimmed = path.trim();
		if ( trimmed.length === 0 ) {

			return NodePath.empty;

		}

		const parts = trimmed.split( '/' );
		const ids = [];
		for ( const part of parts ) {

			if ( part.length === 0 ) {

				throw new Error( `[NodePath] Empty segment in path "${ path }"` );

			}

			const id = nodeIdFromString( part );
			if ( id === null ) {

				throw new Error( `[NodePath] Invalid segment "${ part }" in path "${ path }"` );

			}

			ids.push( id );

		}

		return new NodePath( ids );

	}

	/**
	 * @param {NodePath|string} path
	 * @return {NodePath}
	 */
	static coerce( path ) {

		return typeof path === 'string' ? NodePath.fromString( path ) : path;

	}

	/** @return {number} */
	get length() {

		return this.ids.length;

	}

	/** @return {boolean} */
	get isEmpty() {

		return this.ids.length === 0;

	}

	/** @return {string} */
	toString() {

		return this.ids.map( nodeIdToString ).join( '/' );

	}

	/**
	 * @param {NodePath} other
	 * @return {boolean}
	 */
	equals( other ) {

		if ( this.ids.length !== other.ids.length ) {

			return false;

		}

		for ( let i = 0; i < this.ids.length; i ++ ) {

			if ( this.ids[ i ] !== other.ids[ i ] ) {

				return false;

			}

		}

		return true;

	}

	/**
	 * @param {NodePath} prefix
	 * @return {boolean}
	 */
	startsWith( prefix ) {

		if ( prefix.ids.length > this.ids.length ) {

			return false;

		}

		for ( let i = 0; i < prefix.ids.length; i ++ ) {

			if ( this.ids[ i ] !== prefix.ids[ i ] ) {

				return false;

			}

		}

		return true;

	}

	/**
	 * @param {number} start
	 * @param {number} [end]
	 * @return {NodePath}
	 */
	slice( start, end ) {

		return new NodePath( this.ids.slice( start, end ) );

	}

	/**
	 * @param {NodePath} relative
	 * @return {NodePath}
	 */
	concat( relative ) {

		return new NodePath( [ ...this.ids, ...relative.ids ] );

	}

	/**
	 * If this path starts with `ancestor`, returns the remainder; otherwise `null`.
	 * @param {NodePath} ancestor
	 * @return {?NodePath}
	 */
	relativeFrom( ancestor ) {

		if ( ! this.startsWith( ancestor ) ) {

			return null;

		}

		return this.slice( ancestor.length );

	}

}

NodePath.empty = new NodePath( [] );

export { NodePath };
// !WITH_GENESYS
