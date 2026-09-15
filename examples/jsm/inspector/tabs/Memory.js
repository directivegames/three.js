import { Tab } from '../ui/Tab.js';
import { List } from '../ui/List.js';
import { Graph } from '../ui/Graph.js';
import { Item } from '../ui/Item.js';
import {
	createValueSpan,
	setText,
	formatBytes,
	info,
	// WITH_GENESYS
	getJSHeapBytes
	// !WITH_GENESYS
} from '../ui/utils.js';

class Memory extends Tab {

	constructor( options = {} ) {

		super( 'Memory', options );

		const memoryList = new List( 'Name', 'Count', 'Size' );
		memoryList.setGridStyle( 'minmax(200px, 2fr) 60px 100px' );
		memoryList.domElement.style.minWidth = '300px';

		const scrollWrapper = document.createElement( 'div' );
		scrollWrapper.className = 'list-scroll-wrapper';
		scrollWrapper.appendChild( memoryList.domElement );
		this.content.appendChild( scrollWrapper );

		// graph

		const graphContainer = document.createElement( 'div' );
		graphContainer.className = 'graph-container';

		const graph = new Graph();
		graph.addLine( 'total', 'var( --color-yellow )' );
		// WITH_GENESYS
		graph.addLine( 'jsHeap', 'var( --color-accent )' );
		// !WITH_GENESYS
		graphContainer.append( graph.domElement );

		// stats

		const graphStats = new Item( 'Graph Stats', '', '' );
		memoryList.add( graphStats );

		const graphItem = new Item( graphContainer );
		graphItem.itemRow.childNodes[ 0 ].style.gridColumn = '1 / -1';
		graphStats.add( graphItem );

		// WITH_GENESYS
		const legend = document.createElement( 'div' );
		legend.className = 'graph-caption graph-legend';
		legend.innerHTML = '<span class="graph-legend-item graph-legend-gpu">GPU</span><span class="graph-legend-item graph-legend-heap">JS Heap</span>';
		graphContainer.prepend( legend );
		// !WITH_GENESYS

		// info

		this.memoryStats = new Item( 'Renderer Info', '', createValueSpan() );
		this.memoryStats.domElement.firstChild.classList.add( 'no-hover' );
		memoryList.add( this.memoryStats );

		this.attributes = new Item( 'Attributes', createValueSpan(), createValueSpan() );
		this.memoryStats.add( this.attributes );

		this.geometries = new Item( 'Geometries', createValueSpan(), 'N/A' );
		this.memoryStats.add( this.geometries );

		this.indexAttributes = new Item( 'Index Attributes', createValueSpan(), createValueSpan() );
		this.memoryStats.add( this.indexAttributes );

		this.indirectStorageAttributes = new Item( 'Indirect Storage Attributes', createValueSpan(), createValueSpan() );
		this.memoryStats.add( this.indirectStorageAttributes );

		this.programs = new Item( 'Programs', createValueSpan(), createValueSpan() );
		this.memoryStats.add( this.programs );

		this.readbackBuffers = new Item( 'Readback Buffers', createValueSpan(), createValueSpan() );
		this.memoryStats.add( this.readbackBuffers );

		this.renderTargets = new Item( 'Render Targets', createValueSpan(), 'N/A' );
		this.memoryStats.add( this.renderTargets );

		this.storageAttributes = new Item( 'Storage Attributes', createValueSpan(), createValueSpan() );
		this.memoryStats.add( this.storageAttributes );

		this.textures = new Item( 'Textures', createValueSpan(), createValueSpan() );
		this.memoryStats.add( this.textures );

		this.uniformBuffers = new Item( 'Uniform Buffers', createValueSpan(), createValueSpan() );
		this.memoryStats.add( this.uniformBuffers );

		// WITH_GENESYS
		this.jsHeapStats = new Item( 'JS Heap', '', createValueSpan() );
		this.jsHeapStats.domElement.firstChild.classList.add( 'no-hover' );
		memoryList.add( this.jsHeapStats );
		info( this.jsHeapStats.domElement.querySelector( '.list-item-cell' ), 'Chromium reports V8 heap via performance.memory (used / allocated / limit). Other browsers only report a page-memory estimate if performance.measureUserAgentSpecificMemory is available in a cross-origin isolated document. Safari and Firefox do not expose JS heap size to web pages.' );

		this.jsHeapAllocated = new Item( 'Allocated', '', createValueSpan() );
		this.jsHeapStats.add( this.jsHeapAllocated );

		this.jsHeapLimit = new Item( 'Limit', '', createValueSpan() );
		this.jsHeapStats.add( this.jsHeapLimit );
		// !WITH_GENESYS

		this.graph = graph;

	}

	updateGraph( inspector ) {

		const renderer = inspector.getRenderer();
		if ( ! renderer ) return;

		const memory = renderer.info.memory;

		this.graph.addPoint( 'total', memory.total );

		// WITH_GENESYS
		const heap = getJSHeapBytes();

		if ( heap ) {

			this.graph.addPoint( 'jsHeap', heap.used );

		}
		// !WITH_GENESYS

		if ( this.graph.limit === 0 ) this.graph.limit = 1;

		this.graph.update();

	}

	updateText( inspector ) {

		const renderer = inspector.getRenderer();
		if ( ! renderer ) return;

		const memory = renderer.info.memory;

		setText( this.memoryStats.data[ 2 ], formatBytes( memory.total ) );

		setText( this.attributes.data[ 1 ], memory.attributes.toString() );
		setText( this.attributes.data[ 2 ], formatBytes( memory.attributesSize ) );

		setText( this.geometries.data[ 1 ], memory.geometries.toString() );

		setText( this.indexAttributes.data[ 1 ], memory.indexAttributes.toString() );
		setText( this.indexAttributes.data[ 2 ], formatBytes( memory.indexAttributesSize ) );

		setText( this.indirectStorageAttributes.data[ 1 ], memory.indirectStorageAttributes.toString() );
		setText( this.indirectStorageAttributes.data[ 2 ], formatBytes( memory.indirectStorageAttributesSize ) );

		setText( this.programs.data[ 1 ], memory.programs.toString() );
		setText( this.programs.data[ 2 ], formatBytes( memory.programsSize ) );

		setText( this.readbackBuffers.data[ 1 ], memory.readbackBuffers.toString() );
		setText( this.readbackBuffers.data[ 2 ], formatBytes( memory.readbackBuffersSize ) );

		setText( this.renderTargets.data[ 1 ], memory.renderTargets.toString() );

		setText( this.storageAttributes.data[ 1 ], memory.storageAttributes.toString() );
		setText( this.storageAttributes.data[ 2 ], formatBytes( memory.storageAttributesSize ) );

		setText( this.textures.data[ 1 ], memory.textures.toString() );
		setText( this.textures.data[ 2 ], formatBytes( memory.texturesSize ) );

		setText( this.uniformBuffers.data[ 1 ], memory.uniformBuffers.toString() );
		setText( this.uniformBuffers.data[ 2 ], formatBytes( memory.uniformBuffersSize ) );

		// WITH_GENESYS
		const heap = getJSHeapBytes();

		if ( heap ) {

			setText( this.jsHeapStats.data[ 2 ], formatBytes( heap.used ) );
			setText( this.jsHeapAllocated.data[ 2 ], heap.total !== undefined ? formatBytes( heap.total ) : 'N/A' );
			setText( this.jsHeapLimit.data[ 2 ], heap.limit !== undefined ? formatBytes( heap.limit ) : 'N/A' );

		} else {

			setText( this.jsHeapStats.data[ 2 ], 'Unsupported' );
			setText( this.jsHeapAllocated.data[ 2 ], 'N/A' );
			setText( this.jsHeapLimit.data[ 2 ], 'N/A' );

		}
		// !WITH_GENESYS

	}

}

export { Memory };
