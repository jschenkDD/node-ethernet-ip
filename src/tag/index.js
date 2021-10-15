const { EventEmitter } = require("events");
const crypto = require("crypto");
const { CIP } = require("../enip");
const { MessageRouter } = CIP;
const { READ_TAG, WRITE_TAG, READ_MODIFY_WRITE_TAG } = MessageRouter.services;
const { Types, getTypeCodeString, isValidTypeCode } = require("../enip/cip/data-types");
const dateFormat = require("dateformat");

// Static Class Property - Tracks Instances
let instances = 0;
class Tag extends EventEmitter {
    constructor(tagname, program = null, datatype = null, keepAlive = 0) {
        super();

        if (!Tag.isValidTagname(tagname)) throw new Error("Tagname Must be of Type <string>");
        if (!isValidTypeCode(datatype) && datatype !== null && typeof datatype !== "string")
            throw new Error("Datatype must be a Valid Type Code <number> or <string>");
        if (typeof keepAlive !== "number")
            throw new Error(
                `Tag expected keepAlive of type <number> instead got type <${typeof keepAlive}>`
            );
        if (keepAlive < 0)
            throw new Error(`Tag expected keepAlive to be greater than 0, got ${keepAlive}`);

        // Increment Instances
        instances += 1;

        // Split by "." for memebers
        // Split by "[" or "]" for array indexes
        // Split by "," for array indexes with more than 1 dimension
        // Filter for length > 0 to remove empty elements (happens if tag ends with array index)
        let pathArr = tagname.split(/[.[\],]/).filter(segment => segment.length > 0);

        let bitIndex = null;

        // Check for bit index (tag ends in .int) - this only applies to SINT, INT, DINT or array elements of
        // Split by "." to only check udt members and bit index.
        let memArr = tagname.split(".");
        let isBitIndex = (memArr.length > 1) & (memArr[memArr.length - 1] % 1 === 0);

        // Check if BIT_STRING data type was passed in
        let isBitString = datatype === Types.BIT_STRING && pathArr[pathArr.length - 1] % 1 === 0;

        // Tag can not be both a bit index and BIT_STRING
        if (isBitString && isBitIndex)
            throw new Error("Tag cannot be defined as a BIT_STRING and have a bit index");

        if (isBitString) {
            // BIT_STRING need to be converted to array with bit index
            // tag[x] converts to tag[(x-x%32)/32].x%32
            // e.g. tag[44] turns into tag[1].12
            bitIndex = parseInt(pathArr[pathArr.length - 1]) % 32;
            pathArr[pathArr.length - 1] = (
                (parseInt(pathArr[pathArr.length - 1]) - bitIndex) /
                32
            ).toString();
        } else {
            if (isBitIndex) {
                // normal bit index handling
                bitIndex = parseInt(pathArr.pop(-1));
                if ((bitIndex < 0) | (bitIndex > 31))
                    throw new Error(`Tag bit index must be between 0 and 31, received ${bitIndex}`);
            }
        }

        let bufArr = [];

        // Push Program Path to Buffer if Present
        if (program) bufArr.push(CIP.EPATH.segments.DATA.build(`Program:${program}`));

        // Build EPATH Buffer
        for (let path of pathArr) {
            bufArr.push(CIP.EPATH.segments.DATA.build(path));
        }

        const pathBuf = Buffer.concat(bufArr);

        //buffer for instance id
        let bitIndexBuf = Buffer.alloc(1);
        if (bitIndex === null) bitIndexBuf.writeInt8(32);
        else bitIndexBuf.writeInt8(bitIndex);

        let instanceBuf = Buffer.concat([pathBuf, bitIndexBuf]);

        this.state = {
            tag: {
                bitIndex,
                program,
                name: tagname,
                type: datatype,
                value: null,
                controller: null,
                controllerValue: null,
                path: pathBuf,
                stage_write: false
            },
            read_size: 0x01,
            error: { code: null, status: null },
            timestamp: new Date(),
            instance: hash(instanceBuf),
            keepAlive: keepAlive
        };
    }

    // region Property Accessors
    /**
     * Returns the total number of Tag Instances
     * that have been Created
     *
     * @readonly
     * @static
     * @returns {number} instances
     * @memberof Tag
     */
    static get instances() {
        return instances;
    }

    /**
     * Returns the Tag Instance ID
     *
     * @readonly
     * @returns {string} Instance ID
     * @memberof Tag
     */
    get instance_id() {
        return this.state.instance;
    }

    /**
     * Gets Tagname
     *
     * @memberof Tag
     * @returns {string} tagname
     */
    get name() {
        const { program, name } = this.state.tag;

        if (program === null) {
            return name;
        } else {
            return `Program:${program}.${name}`;
        }
    }

    /**
     * Sets Tagname if Valid
     *
     * @memberof Tag
     * @property {string} New Tag Name
     */
    set name(name) {
        if (!Tag.isValidTagname(name)) throw new Error("Tagname Must be of Type <string>");
        this.state.tag.name = name;
    }

    /**
     * Gets Tag Datatype
     *
     * @memberof Tag
     * @returns {string} datatype
     */
    get type() {
        const { type } = this.state.tag;
        return getTypeCodeString(type) || type;
    }

    /**
     * Sets Tag Datatype if Valid
     *
     * @memberof Tag
     * @property {number} Valid Datatype Code
     */
    set type(type) {
        if (!isValidTypeCode(type) && typeof type !== "string") throw new Error("Datatype must be a Valid Type Code <number> or <string>");
        this.state.tag.type = type;
    }

    /**
     * Gets Tag Bit Index
     * - Returns null if no bit index has been assigned
     *
     * @memberof Tag
     * @returns {number} bitIndex
     */
    get bitIndex() {
        return this.state.tag.bitIndex;
    }

    /**
     * Gets Tag Read Size
     *
     * @memberof Tag
     * @returns {number} read size
     */
    get read_size() {
        return this.state.read_size;
    }

    /**
     * Sets Tag Read Size
     *
     * @memberof Tag
     * @property {number} read size
     */
    set read_size(size) {
        if (typeof size !== "number")
            throw new Error("Read Size must be a Valid Type Code <number>");
        this.state.read_size = size;
    }

    /**
     * Gets Tag value
     * - Returns null if no value has been read
     *
     * @memberof Tag
     * @returns {number|string|boolean|object} value
     */
    get value() {
        return this.state.tag.value;
    }

    /**
     * Sets Tag Value
     *
     * @memberof Tag
     * @property {number|string|boolean|object} new value
     */
    set value(newValue) {
        this.state.tag.stage_write = true;
        this.state.tag.value = newValue;
    }

    /**
     * Gets Tag parent Controller
     * - Returns null if no value has been read
     *
     * @memberof Tag
     * @returns {object} controller
     */
    get controller() {
        return this.state.tag.controller;
    }

    /**
     * Sets Tag parent Controller
     *
     * @memberof Tag
     * @property {object} new controller
     */
    set controller(controller) {
        this.state.tag.controller = controller;
    }

    /**
     * Sets Controller Tag Value and Emits Changed Event
     *
     * @memberof Tag
     * @property {number|string|boolean|object} new value
     */
    set controller_value(newValue) {
        if (JSON.stringify(newValue) !== JSON.stringify(this.state.tag.controllerValue)) {
            const lastValue = this.state.tag.controllerValue;
            this.state.tag.controllerValue = newValue;

            const { stage_write } = this.state.tag;
            if (!stage_write) this.state.tag.value = newValue;

            this.state.timestamp = new Date();

            if (lastValue !== null) this.emit("Changed", this, lastValue);
            else this.emit("Initialized", this);
        } else {
            if (this.state.keepAlive > 0) {
                const now = new Date();
                if (now - this.state.timestamp >= this.state.keepAlive * 1000) {
                    this.state.tag.controllerValue = newValue;

                    const { stage_write } = this.state.tag;
                    if (!stage_write) this.state.tag.value = newValue;
                    this.state.timestamp = now;

                    this.emit("KeepAlive", this);
                }
            }
        }
    }

    /**
     * Sets Controller Tag Value and Emits Changed Event
     *
     * @memberof Tag
     * @returns {number|string|boolean|object} new value
     */
    get controller_value() {
        return this.state.tag.controllerValue;
    }

    /**
     * Gets Timestamp in a Human Readable Format
     *
     * @readonly
     * @memberof Tag
     * @returns {string}
     */
    get timestamp() {
        return dateFormat(this.state.timestamp, "mm/dd/yyyy-HH:MM:ss.l");
    }

    /**
     * Gets Javascript Date Object of Timestamp
     *
     * @readonly
     * @memberof Tag
     * @returns {Date}
     */
    get timestamp_raw() {
        return this.state.timestamp;
    }

    /**
     * Gets Error
     *
     * @readonly
     * @memberof Tag
     * @returns {object|null} error
     */
    get error() {
        return this.state.error.code ? this.state.error : null;
    }

    /**
     * Returns a Padded EPATH of Tag
     *
     * @readonly
     * @returns {buffer} Padded EPATH
     * @memberof Tag
     */
    get path() {
        return this.state.tag.path;
    }

    /**
     * Returns a whether or not a write is staging
     *
     * @returns {boolean}
     * @memberof Tag
     */
    get write_ready() {
        return this.state.tag.stage_write;
    }
    // endregion

    // region Public Methods
    /**
     * Generates Read Tag Message
     *
     * @param {number} [size=null]
     * @returns {buffer} - Read Tag Message Service
     * @memberof Tag
     */
    generateReadMessageRequest(size = null) {
        if (size) this.state.read_size = size;

        const { tag } = this.state;

        // Build Message Router to Embed in UCMM
        let buf = Buffer.alloc(2);
        buf.writeUInt16LE(this.state.read_size, 0);

        // Build Current Message
        return MessageRouter.build(READ_TAG, tag.path, buf);
    }

    /**
     *  Parses Good Read Request Messages
     *
     * @param {buffer} Data Returned from Successful Read Tag Request
     * @memberof Tag
     */
    parseReadMessageResponse(data) {
        const { tag } = this.state;
        const { SINT, INT, DINT, BIT_STRING, STRUCT, STRING } = Types;

        const type = data.readUInt16LE(0);
        if (!tag.type) tag.type = type;
        else {
            if (tag.type !== type && (typeof tag.type !== "string" || (type !== STRUCT && type !== STRING)))
                throw new Error(`Type Read Mismatch - tag: ${tag.type} vs read: ${type}`);
        }

        // bit index local deserialization
        if (tag.bitIndex !== null)
            /* eslint-disable indent */
            switch (tag.type) {
                case SINT:
                    this.controller_value =
                        (data.readInt8(2) & (1 << tag.bitIndex)) === 0 ? false : true;
                    break;
                case INT:
                    this.controller_value =
                        (data.readInt16LE(2) & (1 << tag.bitIndex)) === 0 ? false : true;
                    break;
                case DINT:
                case BIT_STRING:
                    this.controller_value =
                        (data.readInt32LE(2) & (1 << tag.bitIndex)) === 0 ? false : true;
                    break;
                default:
                    throw new Error(
                        "Data Type other than SINT, INT, DINT, or BIT_STRING returned when a Bit Index was requested"
                    );
            }
            /* eslint-enable indent */
        // not a bit index - template deserialization
        else{
            const template = this._getTemplate();
            if (type === STRUCT) {
                template.structure_handle = data.readUInt16LE(2);
                this.controller_value = template.deserialize(data.slice(4));
            }
            else this.controller_value = template.deserialize(data.slice(2));
        }
    }

    /**
     * Generates Write Tag Message
     *
     * @param {number|boolean|object|string} [newValue=null] - If Omitted, Tag.value will be used
     * @param {number} [size=0x01]
     * @returns {buffer} - Write Tag Message Service
     * @memberof Tag
     */
    generateWriteMessageRequest(value = null, size = 0x01) {
        const { tag } = this.state;
        const { SINT, INT, DINT, BIT_STRING } = Types;

        if (value !== null) tag.value = value;

        if (tag.type === null )
            throw new Error(
                `Tag ${
                    tag.name
                } has not been initialized. Try reading the tag from the controller first or manually providing a valid CIP datatype.`
            );

        let buf = null;

        // bit index = local serialization
        if (tag.bitIndex !== null){
            /* eslint-disable indent */
            switch (tag.type) {
                case SINT:
                    buf = Buffer.alloc(4);
                    buf.writeInt16LE(1); //mask length
                    buf.writeUInt8(tag.value ? 1 << tag.bitIndex : 0, 2); // or mask
                    buf.writeUInt8(tag.value ? 255 : 255 & ~(1 << tag.bitIndex), 3); // and mask
                    break;
                case INT:
                    buf = Buffer.alloc(6);
                    buf.writeInt16LE(2); //mask length
                    buf.writeUInt16LE(tag.value ? 1 << tag.bitIndex : 0, 2); // or mask
                    buf.writeUInt16LE(tag.value ? 65535 : 65535 & ~(1 << tag.bitIndex), 4); // and mask
                    break;
                case DINT:
                case BIT_STRING:
                    buf = Buffer.alloc(10);
                    buf.writeInt16LE(4); //mask length
                    buf.writeInt32LE(tag.value ? 1 << tag.bitIndex : 0, 2); // or mask
                    buf.writeInt32LE(tag.value ? -1 : -1 & ~(1 << tag.bitIndex), 6); // and mask
                    break;
                default:
                    throw new Error(
                        "Bit Indexes can only be used on SINT, INT, DINT, or BIT_STRING data types."
                    );
            }

            // Build Current Message
            return MessageRouter.build(READ_MODIFY_WRITE_TAG, tag.path, buf);
        }

        const template = this._getTemplate();

        // default - template serialization
        if (typeof tag.type === "string"){
            buf = Buffer.alloc(6);
            buf.writeUInt16LE(Types.STRUCT, 0);
            buf.writeUInt16LE(template.structure_handle, 2);
            buf.writeUInt16LE(size, 4);
        } else {
            buf = Buffer.alloc(4);
            buf.writeUInt16LE(tag.type, 0);
            buf.writeUInt16LE(size, 2);
        }
        return MessageRouter.build(WRITE_TAG, tag.path, Buffer.concat([buf,template.serialize(tag.value)]));
    }

    /**
     * Unstages Value Edit
     *
     * @memberof Tag
     */
    unstageWriteRequest() {
        const { tag } = this.state;
        tag.stage_write = false;
        tag.value = tag.controllerValue;
    }
    // endregion

    // region Private Methods
    /**
     * Gets Tag Template
     *
     * @memberof Tag
     */
    _getTemplate() {
        const { tag } = this.state;

        if (!tag.controller) throw new Error("Template read error - tag controller property not set");
        if (!tag.controller.templates) throw new Error("Template read error - tag controller templates property not set");
        if (!tag.type) {
            throw new Error(`Template read error - tag type property not set for tag ${tag.name}`);
        }

        const template = tag.controller.templates[tag.type];

        if (!template) {
            console.error("Could not find template for ", tag.name);
            throw new Error(`Template read error - cannot find template for type: ${tag.type}`);
        }

        return template;
    }
    // endregion

    /**
     * Determines if a Tagname is Valid
     *
     * @static
     * @param {string} tagname
     * @returns {boolean}
     * @memberof Tag
     */
    static isValidTagname(tagname) {
        if (typeof tagname !== "string") return false;

        // regex components
        const nameRegex = captureIndex => {
            return `(_?[a-zA-Z]|_\\d)(?:(?=(_?[a-zA-Z0-9]))\\${captureIndex})*`;
        };
        const multDimArrayRegex = "(\\[\\d+(,\\d+){0,2}])";
        const arrayRegex = "(\\[\\d+])";
        const bitIndexRegex = "(\\.\\d{1,2})";

        // user regex for user tags
        const userRegex = new RegExp(
            "^(Program:" +
            nameRegex(3) +
            "\\.)?" + // optional program name
            nameRegex(5) +
            multDimArrayRegex +
            "?" + // tag name
            "(\\." +
            nameRegex(10) +
            arrayRegex +
            "?)*" + // option member name
                bitIndexRegex +
                "?$"
        ); // optional bit index
        // full user regex
        // ^(Program:(_?[a-zA-Z]|_\d)(?:(?=(_?[a-zA-Z0-9]))\3)*\.)?(_?[a-zA-Z]|_\d)(?:(?=(_?[a-zA-Z0-9]))\5)*(\[\d+(,\d+){0,2}])?(\.(_?[a-zA-Z]|_\d)(?:(?=(_?[a-zA-Z0-9]))\10)*(\[\d+])?)*(\.\d{1,2})?$

        // module regex for module tags
        const moduleRegex = new RegExp(
            "^" +
            nameRegex(2) + // module name
            "(:\\d{1,2})?" + // optional slot num (not required for rack optimized connections)
            ":[IOC]" + // input/output/config
            "(\\." +
            nameRegex(6) +
            arrayRegex +
            "?)?" + // optional member with optional array index
                bitIndexRegex +
                "?$"
        ); // optional bit index
        // full module regex
        // ^(_?[a-zA-Z]|_\d)(?:(?=(_?[a-zA-Z0-9]))\2)*(:\d{1,2})?:[IOC](\.(_?[a-zA-Z]|_\d)(?:(?=(_?[a-zA-Z0-9]))\6)*(\[\d+])?)?(\.\d{1,2})?$

        if (!userRegex.test(tagname) && !moduleRegex.test(tagname)) return false;

        // check segments
        if (tagname.split(/[:.[\],]/).filter(segment => segment.length > 40).length > 0)
            return false; // check that all segments are <= 40 char

        // passed all tests
        return true;
    }
}

/**
 * Generates Unique ID for Each Instance
 * based on the Generated EPATH
 *
 * @param {buffer} input - EPATH of Tag
 * @returns {string} hash
 */
const hash = input => {
    return crypto
        .createHash("md5")
        .update(input)
        .digest("hex");
};

module.exports = Tag;
