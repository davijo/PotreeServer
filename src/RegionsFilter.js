

const os = require("os");
const fs = require('fs');
const Vector3 = require("./Vector3.js").Vector3;
const Box3 = require("./Box3.js").Box3;
const Plane = require("./Plane.js").Plane;
const PlaneClipRegion = require("./PlaneClipRegion.js").PlaneClipRegion;
const LASHeader = require("./LASHeader.js").LASHeader;
const PointAttribute = require("./PointAttributes.js").PointAttribute;
const PointAttributes = require("./PointAttributes.js").PointAttributes;


let readFile = function(file){
	return new Promise( (resolve, reject) => {
		fs.readFile(file, function (err, data) {
			if(err){
				reject();
			}else{
				resolve(data);
			}
		});
	});
};

let endStream = function(stream){
	return new Promise( (resolve, reject) => {
		stream.on('finish', () => {
			resolve();
		});

		stream.end();
	});
};


// time in seconds
function now(){
	let hrTime = process.hrtime();
	let seconds = hrTime[0] + hrTime[1] / (1000 * 1000 * 1000);

	return seconds;
}


class Node{
	
	constructor(){
		this.children = new Array(8).fill(null);
		this.index = null;
		this.name = "";
		this.box = null;
	}

	traverse(callback){
		let stack = [{node: this, level: 0}];

		while(stack.length > 0){
			let entry = stack.pop();
			let node = entry.node;
			let level = entry.level;

			callback(node, level);

			let children = node.children.filter( c => c !== null );
			for(let child of children.reverse()){
				stack.push({node: child, level: level + 1});
			}
		}
	}

	level(){
		return this.name.length - 1;
	}

}

function getHierarchyPath(name, hierarchyStepSize){
	let path = "r/";
	let indices = name.substr(1);
	let numParts = Math.floor(indices.length / hierarchyStepSize);
	for (let i = 0; i < numParts; i++) {
		path += indices.substr(i * hierarchyStepSize, hierarchyStepSize) + '/';
	}
	path = path.slice(0, -1);
	return path;
}

function parseHierarchy(hrcData, rootName){
	let root = new Node();
	root.name = rootName;

	let nodes = [root];

	let n = hrcData.length / 5;

	for(let i = 0; i < n; i++){
		let childMask = hrcData[5 * i];

		let node = nodes[i];

		for(let j = 0; j < 8; j++){
			let hasChildJ = childMask & (1 << j);
			if(hasChildJ){
				let child = new Node();
				child.index = j;
				child.name = `${node.name}${j}`;

				node.children[j] = child;

				nodes.push(child);
			}
		}
	}

	return root;
}

function createChildAABB(aabb, index){
	let min = aabb.min.clone();
	let max = aabb.max.clone();
	let size = max.clone().sub(min);

	if ((index & 0b0001) > 0) {
		min.z += size.z / 2;
	} else {
		max.z -= size.z / 2;
	}

	if ((index & 0b0010) > 0) {
		min.y += size.y / 2;
	} else {
		max.y -= size.y / 2;
	}

	if ((index & 0b0100) > 0) {
		min.x += size.x / 2;
	} else {
		max.x -= size.x / 2;
	}

	return new Box3(min, max);
}

function escapeReportString(str){
	let result = str.replace(/"<jsremove>/g, "");
	result = result.replace(/<jsremove>"/g, "");
	result = result.replace(/\\"/g, "\"");

	return result;
}

let FilterStatus = {
	UNDEFINED: "UNDEFINED",
	ESTIMATING: "ESTIMATING",
	FILTERING: "FILTERING",
	FINISHED: "FINISHED",
};


class RegionsFilter{

	constructor(path, clipRegions){

		this.path = path;
		this.clipRegions = clipRegions;
		this.filterCalled = false;

		this.estimation =  {
			numNodes: 0,
			numPoints: 0	
		};

		this.progress = {
			numNodes: 0,
			numPoints: 0,
			inside: 0,
			outside: 0,
			timestamps: {}
		};

		this.status = FilterStatus.UNDEFINED;
	}

	async findVisibleNodes(boundingBox){

		let hrcRoot = `${this.path}/../data/r/r.hrc`;
		let hrcData = await readFile(hrcRoot);
		hrcData = new Uint8Array(hrcData);
		
		let root = parseHierarchy(hrcData, "r");

		let visibleNodes = [root];

		{
			root.box = boundingBox.clone();
			let stack = [root];

			while(stack.length > 0){
				// if the stack.shift() way of breadth-first traversal becomes a bottleneck,
				// try https://en.wikipedia.org/wiki/Iterative_deepening_depth-first_search
				let node = stack.shift(); 

				//console.log(node.name);

				for(let child of node.children){
					if(child){

						child.box = createChildAABB(node.box, child.index);

						let intersects = false;
						for(let clipRegion of this.clipRegions){
							intersects = intersects || clipRegion.intersectsBox(child.box);
						}
						let atHierarchyStep = (child.level() % this.cloudjs.hierarchyStepSize) === 0;

						if(intersects && !atHierarchyStep){
							visibleNodes.push(child);
							stack.push(child);
						}else if(intersects && atHierarchyStep){
							visibleNodes.push(child);

							let hierarchyPath = getHierarchyPath(child.name, this.cloudjs.hierarchyStepSize);
							let hrcPath = `${this.path}/../data/${hierarchyPath}/${child.name}.hrc`;

							let hrcData = await readFile(hrcPath);
							hrcData = new Uint8Array(hrcData);

							let croot = parseHierarchy(hrcData, child.name);
							croot.box = child.box;
							croot.index = child.index;

							//child.children = croot.children;
							stack.push(croot);
						}

					}
				}
			}
		}

		return visibleNodes;
	}

	async estimate(){

		this.progress.timestamps["estimate-start"] = now();

		let cloudjsContent;
		try{
			cloudjsContent = await fs.promises.readFile(this.path, "utf8");
		}catch(e){
			console.log(e);
			return null;
		}

		this.status = FilterStatus.ESTIMATING;

		this.cloudjs = JSON.parse(cloudjsContent.toString());

		let attributes = new PointAttributes(this.cloudjs.pointAttributes.map(name => PointAttribute[name]));

		let boundingBox = new Box3(
			new Vector3(this.cloudjs.boundingBox.lx, this.cloudjs.boundingBox.ly, this.cloudjs.boundingBox.lz),
			new Vector3(this.cloudjs.boundingBox.ux, this.cloudjs.boundingBox.uy, this.cloudjs.boundingBox.uz)
		);

		let visibleNodes = await this.findVisibleNodes(boundingBox);

		let totalBytes = 0;
		for(let node of visibleNodes){
			
			let hierarchyPath = getHierarchyPath(node.name, this.cloudjs.hierarchyStepSize);
			let nodePath = `${this.path}/../data/${hierarchyPath}/${node.name}.bin`;

			let stat = await fs.promises.stat(nodePath);

			totalBytes += stat.size;
		}

		let estimation = {
			numNodes: visibleNodes.length,
			numPoints: totalBytes / attributes.bytes
		};

		this.estimation = estimation;

		this.progress.timestamps["estimate-end"] = now();

		return estimation;
	}

	async updateReport(){
		let infos = {
			"status": this.status,
			"path": this.path,
		};

		{
			let durations = {};

			let estimateStart = this.progress.timestamps["estimate-start"];
			let estimateEnd = this.progress.timestamps["estimate-end"];

			let filterStart = this.progress.timestamps["filter-start"];
			let filterEnd = this.progress.timestamps["filter-end"];

			if(estimateEnd){
				let estimateDuration = estimateEnd - estimateStart;
				durations["estimate"] = `${estimateDuration.toFixed(3)}s`;
			}

			if(filterEnd){
				let filterDuration = filterEnd - filterStart;
				durations["filter"] = `${filterDuration.toFixed(3)}s`;
			}

			infos.durations = durations;
		}

		for(let region of this.clipRegions){
			for(let plane of region.planes){
				plane.toJSON = () => `<jsremove>{"normal": [${plane.normal.toArray().join(", ")}], "distance": ${plane.distance}}<jsremove>`;
			}
		}

		infos["estimate"] = {
			nodes: this.estimation.numNodes,
			points: this.estimation.numPoints,
		};

		infos["progress"] = {
			"processed nodes": this.progress.numNodes,
			"processed points": this.progress.numPoints,
			"accepted points": this.progress.inside,
			"discarded points": this.progress.outside
		};
		
		infos["clip regions"] = this.clipRegions;
		
		let infoString = JSON.stringify(infos, null, "\t");
		infoString = escapeReportString(infoString);

		await fs.promises.writeFile(this.reportPath, infoString, {encoding: "utf8"});
	}

	async filter(outPath){

		this.progress.timestamps["filter-start"] = now();

		if(this.filterCalled){
			throw new Error("Can't call filter twice. Create a new RegionsFilter instead.");
		}
		
		this.filterCalled = true;

		this.reportPath = `${outPath}/report.json`;

		await fs.promises.mkdir(outPath);

		this.status = FilterStatus.FILTERING;
		this.updateReport();

		let cloudjsContent;
		try{
			cloudjsContent = await fs.promises.readFile(this.path, "utf8");
		}catch(e){
			console.log(e);

			await fs.promises.unlink(this.reportPath);

			let files = await fs.readdir(outPath);
			if(files.length === 0){
				fs.promises.rmdir(outPath);
			}

			return;
		}

		this.cloudjs = JSON.parse(cloudjsContent.toString());

		let attributes = new PointAttributes(this.cloudjs.pointAttributes.map(name => PointAttribute[name]));

		let boundingBox = new Box3(
			new Vector3(this.cloudjs.boundingBox.lx, this.cloudjs.boundingBox.ly, this.cloudjs.boundingBox.lz),
			new Vector3(this.cloudjs.boundingBox.ux, this.cloudjs.boundingBox.uy, this.cloudjs.boundingBox.uz)
		);

		let visibleNodes = await this.findVisibleNodes(boundingBox);

		let promises = [];

		let inside = 0;
		let outside = 0;
		let outFile = `${outPath}/filtered.las`;

		let wstream = fs.createWriteStream(outFile);

		let lasHeader = new LASHeader();
		lasHeader.scale = this.cloudjs.scale;
		lasHeader.min = boundingBox.min.toArray();
		lasHeader.max = boundingBox.max.toArray();

		wstream.write(lasHeader.toBuffer());

		let filterDuration = 0;

		let readPos = attributes.contains(PointAttribute.POSITION_CARTESIAN);
		let readColor = attributes.contains(PointAttribute.COLOR_PACKED);
		let offsetPos = attributes.offsetOf(PointAttribute.POSITION_CARTESIAN);
		let offsetColor = attributes.offsetOf(PointAttribute.COLOR_PACKED);

		for(let node of visibleNodes){

			let hierarchyPath = getHierarchyPath(node.name, this.cloudjs.hierarchyStepSize);
			let nodePath = `${this.path}/../data/${hierarchyPath}/${node.name}.bin`;
			let promise = readFile(nodePath);
			promises.push(promise);

			promise.then( (result) => {

				let filterStart = now();

				let buffer = result;

				let numPoints = buffer.length / attributes.bytes;
				let vec = new Vector3();

				let lasRecordLength = 26;
				let outBuffer = Buffer.from(new Uint8Array(lasRecordLength * numPoints));

				let tmpBuffer = new ArrayBuffer(4);
				let tmpUint32 = new Uint32Array(tmpBuffer);
				let tmpUint8 = new Uint8Array(tmpBuffer);

				let insideThis = 0;
				let outOffset = 0;
				let inOffset = 0;
				let [ux, uy, uz] = [0, 0, 0];
				let [x, y, z] = [0, 0, 0];
				let [r, g, b] = [0, 0, 0];

				for(let i = 0; i < numPoints; i++){

					inOffset = attributes.bytes * i;

					if(readPos){
						ux = buffer.readUInt32LE(inOffset + offsetPos + 0);
						uy = buffer.readUInt32LE(inOffset + offsetPos + 4);
						uz = buffer.readUInt32LE(inOffset + offsetPos + 8);

						x = ux * this.cloudjs.scale + node.box.min.x;
						y = uy * this.cloudjs.scale + node.box.min.y;
						z = uz * this.cloudjs.scale + node.box.min.z;
					}
							
					if(readColor){
						r = buffer[inOffset + offsetColor + 0];
						g = buffer[inOffset + offsetColor + 1];
						b = buffer[inOffset + offsetColor + 2];
					}

					vec.x = x;
					vec.y = y;
					vec.z = z;

					let isInside = false;
					for(let clipRegion of this.clipRegions){
						isInside = isInside || clipRegion.containsPoint(vec);
					}
					//let isInside = clipRegion.containsPoint(vec);

					if(isInside){
						outOffset = insideThis * lasRecordLength;

						let ux = (x - boundingBox.min.x) / this.cloudjs.scale;
						let uy = (y - boundingBox.min.y) / this.cloudjs.scale;
						let uz = (z - boundingBox.min.z) / this.cloudjs.scale;

						// relatively slow
						//outBuffer.writeInt32LE(ux, outOffset + 0);
						//outBuffer.writeInt32LE(uy, outOffset + 4);
						//outBuffer.writeInt32LE(uz, outOffset + 8);

						// reduces filter duration from ~1.95s to ~1.58s
						tmpUint32[0] = ux;
						outBuffer[outOffset + 0] = tmpUint8[0];
						outBuffer[outOffset + 1] = tmpUint8[1];
						outBuffer[outOffset + 2] = tmpUint8[2];
						outBuffer[outOffset + 3] = tmpUint8[3];

						tmpUint32[0] = uy;
						outBuffer[outOffset + 4] = tmpUint8[0];
						outBuffer[outOffset + 5] = tmpUint8[1];
						outBuffer[outOffset + 6] = tmpUint8[2];
						outBuffer[outOffset + 7] = tmpUint8[3];

						tmpUint32[0] = uz;
						outBuffer[outOffset + 8] = tmpUint8[0];
						outBuffer[outOffset + 9] = tmpUint8[1];
						outBuffer[outOffset + 10] = tmpUint8[2];
						outBuffer[outOffset + 11] = tmpUint8[3];

						
						// relatively slow
						//outBuffer.writeInt16LE(r, outOffset + 20);
						//outBuffer.writeInt16LE(g, outOffset + 22);
						//outBuffer.writeInt16LE(b, outOffset + 24);

						// further reduces filter duration from ~1.58s to ~1.27s
						outBuffer[outOffset + 20] = r;
						outBuffer[outOffset + 22] = g;
						outBuffer[outOffset + 24] = b;

						inside++;
						insideThis++;
					}else{
						outside++;
					}

				}

				outBuffer = outBuffer.subarray(0, insideThis * lasRecordLength);

				let filterEnd = now();
				filterDuration += filterEnd - filterStart;

				wstream.write(outBuffer);

				this.progress.numNodes++;
				this.progress.numPoints += numPoints;
				this.progress.inside = inside;
				this.progress.outside = outside;
				this.progress.timestamps["filter-end"] = now();

				this.updateReport();
			});
		}

		await Promise.all(promises);

		await endStream(wstream);

		// update header
		lasHeader.numPoints = inside;
		let headerBuffer = lasHeader.toBuffer();
		let filehandle = await fs.promises.open(outFile, 'r+');
		await filehandle.write(headerBuffer);
		await filehandle.close();

		let stats = fs.statSync(outFile);
		let mb = stats.size / (1024 * 1024)

		console.log(`visible nodes: ${visibleNodes.length}`);
		console.log(`inside: ${inside.toLocaleString("en")}, outside: ${outside.toLocaleString("en")}`);
		console.log(`wrote ${outFile} (${parseInt(mb)}MB)`);

		this.status = FilterStatus.FINISHED;
		this.progress.timestamps["filter-end"] = now();
		
		await this.updateReport();
	}

}


module.exports.RegionsFilter = RegionsFilter;
