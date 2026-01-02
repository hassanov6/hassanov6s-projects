// Simplified but specification-aware FIT parser (FitJS)
window.FitParser = class FitParser {
  constructor(options = {}) {
    this.options = {
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'm',
      elapsedRecordField: true,
      mode: 'list',
      ...options
    };

    this.baseTypeInfo = {
      0x00: { name: 'enum', size: 1, invalid: 0xFF, reader: 'getUint8' },
      0x01: { name: 'sint8', size: 1, invalid: 0x7F, reader: 'getInt8' },
      0x02: { name: 'uint8', size: 1, invalid: 0xFF, reader: 'getUint8' },
      0x03: { name: 'sint16', size: 2, invalid: 0x7FFF, reader: 'getInt16' },
      0x04: { name: 'uint16', size: 2, invalid: 0xFFFF, reader: 'getUint16' },
      0x05: { name: 'sint32', size: 4, invalid: 0x7FFFFFFF, reader: 'getInt32' },
      0x06: { name: 'uint32', size: 4, invalid: 0xFFFFFFFF, reader: 'getUint32' },
      0x07: { name: 'string', size: 1, invalid: 0x00, reader: 'string' },
      0x08: { name: 'float32', size: 4, invalid: 0xFFFFFFFF, reader: 'getFloat32' },
      0x09: { name: 'float64', size: 8, invalid: 0xFFFFFFFFFFFFFFFF, reader: 'getFloat64' },
      0x0A: { name: 'uint8z', size: 1, invalid: 0x00, reader: 'getUint8' },
      0x0B: { name: 'uint16z', size: 2, invalid: 0x0000, reader: 'getUint16' },
      0x0C: { name: 'uint32z', size: 4, invalid: 0x00000000, reader: 'getUint32' },
      0x0D: { name: 'byte', size: 1, invalid: null, reader: 'getUint8' },
      0x0E: { name: 'sint64', size: 8, invalid: BigInt('0x7FFFFFFFFFFFFFFF'), reader: 'getBigInt64' },
      0x0F: { name: 'uint64', size: 8, invalid: BigInt('0xFFFFFFFFFFFFFFFF'), reader: 'getBigUint64' },
      0x10: { name: 'uint64z', size: 8, invalid: BigInt(0), reader: 'getBigUint64' }
    };

    this._textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  }

  parse(buffer, callback) {
    try {
      const view = new DataView(buffer);
      const headerLength = view.getUint8(0);

      if (![12, 14, 16].includes(headerLength)) {
        throw new Error(`Invalid header size: ${headerLength}`);
      }

      const dataType = String.fromCharCode(
        view.getUint8(8),
        view.getUint8(9),
        view.getUint8(10),
        view.getUint8(11)
      );

      if (dataType !== '.FIT') {
        throw new Error('Not a FIT file');
      }

      const dataSize = view.getUint32(4, true);
      const dataEnd = headerLength + dataSize;

      this.definitions = {};
      this.lastTimestampSeconds = null;
      this.firstRecordTimestampSeconds = null;

      const result = { records: [], laps: [], sessions: [] };

      let offset = headerLength;

      while (offset < dataEnd) {
        const recordHeader = view.getUint8(offset++);
        const isCompressedTimestamp = (recordHeader & 0x80) !== 0 && (recordHeader & 0x40) === 0;
        const isDefinition = (recordHeader & 0x40) !== 0;

        if (isCompressedTimestamp) {
          offset = this._handleCompressedTimestampMessage(view, offset, recordHeader, result);
        } else if (isDefinition) {
          offset = this._handleDefinitionMessage(view, offset, recordHeader);
        } else {
          offset = this._handleDataMessage(view, offset, recordHeader, result);
        }
      }

      if (result.sessions.length === 0 && result.records.length > 1) {
        const fallbackSession = this._buildFallbackSession(result.records);
        if (fallbackSession) {
          result.sessions.push(fallbackSession);
        }
      }

      callback(null, result);
    } catch (err) {
      callback(err, null);
    }
  }

  _handleDefinitionMessage(view, offset, header) {
    const localMsgType = header & 0x0F;
    const hasDevFields = (header & 0x20) !== 0;

    offset++; // reserved byte
    const architecture = view.getUint8(offset++);
    const littleEndian = architecture === 0;

    const globalMsgNum = view.getUint16(offset, littleEndian);
    offset += 2;

    const fieldCount = view.getUint8(offset++);
    const fields = [];
    let fieldSizeTotal = 0;

    for (let i = 0; i < fieldCount; i++) {
      const fieldDefNum = view.getUint8(offset++);
      const size = view.getUint8(offset++);
      const baseType = view.getUint8(offset++);
      fields.push({ fieldDefNum, size, baseType });
      fieldSizeTotal += size;
    }

    const devFields = [];
    let devFieldSizeTotal = 0;

    if (hasDevFields) {
      const devFieldCount = view.getUint8(offset++);
      for (let i = 0; i < devFieldCount; i++) {
        const fieldDefNum = view.getUint8(offset++);
        const size = view.getUint8(offset++);
        const devDataIndex = view.getUint8(offset++);
        devFields.push({ fieldDefNum, size, devDataIndex });
        devFieldSizeTotal += size;
      }
    }

    this.definitions[localMsgType] = {
      globalMsgNum,
      littleEndian,
      fields,
      devFields,
      fieldSize: fieldSizeTotal,
      devFieldSize: devFieldSizeTotal,
      totalSize: fieldSizeTotal + devFieldSizeTotal
    };

    return offset;
  }

  _handleDataMessage(view, offset, header, result) {
    const localMsgType = header & 0x0F;
    const definition = this.definitions[localMsgType];

    if (!definition) {
      throw new Error(`Data message without definition for local message ${localMsgType}`);
    }

    const parsed = this._parseDataMessage(view, offset, definition, null);
    if (parsed && parsed.message) {
      this._dispatchMessage(parsed.message, result);
    }

    return offset + definition.totalSize;
  }

  _handleCompressedTimestampMessage(view, offset, header, result) {
    const localMsgType = (header >> 5) & 0x03;
    const timeOffset = header & 0x1F;
    const definition = this.definitions[localMsgType];

    if (!definition) {
      throw new Error(`Compressed data message without definition for local message ${localMsgType}`);
    }

    if (this.lastTimestampSeconds === null) {
      // No reference timestamp yet; skip message but keep parser alive
      return offset + definition.totalSize;
    }

    const timestampSeconds = this._computeCompressedTimestamp(timeOffset);
    const parsed = this._parseDataMessage(view, offset, definition, timestampSeconds);
    if (parsed && parsed.message) {
      this._dispatchMessage(parsed.message, result);
    }

    return offset + definition.totalSize;
  }

  _parseDataMessage(view, offset, definition, forcedTimestampSeconds) {
    const { fields, devFieldSize, littleEndian } = definition;
    const data = {};

    let cursor = offset;

    for (const field of fields) {
      const value = this._readField(view, cursor, field.size, field.baseType, littleEndian);
      if (value !== null && value !== undefined) {
        data[field.fieldDefNum] = value;
      }
      cursor += field.size;
    }

    cursor += devFieldSize; // skip developer data (not parsed here)

    return {
      message: this._translateMessage(definition.globalMsgNum, data, forcedTimestampSeconds),
      size: definition.totalSize
    };
  }

  _translateMessage(globalMsgNum, data, forcedTimestampSeconds) {
    switch (globalMsgNum) {
      case 20: // record
        return this._buildRecord(data, forcedTimestampSeconds);
      case 19: // lap
        return this._buildLap(data, forcedTimestampSeconds);
      case 18: // session
        return this._buildSession(data, forcedTimestampSeconds);
      default:
        return null;
    }
  }

  _buildRecord(data, forcedTimestampSeconds) {
    let timestampSeconds = data[253];
    if (timestampSeconds == null) {
      timestampSeconds = forcedTimestampSeconds;
    } else {
      this.lastTimestampSeconds = timestampSeconds;
    }

    if (timestampSeconds != null && this.firstRecordTimestampSeconds == null) {
      this.firstRecordTimestampSeconds = timestampSeconds;
    }

    const record = {};

    if (timestampSeconds != null) {
      record.timestamp = this._convertTimestamp(timestampSeconds);
    }

    if (data[0] != null) {
      record.position_lat = this._semicirclesToDegrees(data[0]);
    }

    if (data[1] != null) {
      record.position_long = this._semicirclesToDegrees(data[1]);
    }

    const altitudeRaw = data[78] ?? data[2];
    if (altitudeRaw != null) {
      const altitudeMeters = this._convertAltitudeRaw(altitudeRaw);
      record.altitude = this._convertLength(altitudeMeters);
      record.altitude_unit = this.options.lengthUnit;
      record.altitude_m = altitudeMeters;
    }

    if (data[3] != null) {
      record.heart_rate = data[3];
    }

    if (data[4] != null) {
      record.cadence = data[4];
    }

    const distanceRaw = data[5];
    if (distanceRaw != null) {
      const distanceMeters = distanceRaw / 100;
      record.distance = this._convertLength(distanceMeters);
      record.distance_unit = this.options.lengthUnit;
      record.distance_m = distanceMeters;
    }

    const enhancedSpeedRaw = data[73];
    const speedRaw = enhancedSpeedRaw != null ? enhancedSpeedRaw : data[6];
    if (speedRaw != null) {
      const speedMps = speedRaw / 1000;
      record.speed = this._convertSpeed(speedMps);
      record.speed_unit = this.options.speedUnit;
      record.speed_mps = speedMps;
    }

    if (data[13] != null) {
      record.temperature = data[13];
    }

    if (this.options.elapsedRecordField && timestampSeconds != null && this.firstRecordTimestampSeconds != null) {
      record.elapsed_time = (timestampSeconds - this.firstRecordTimestampSeconds);
    }

    return { type: 'record', value: record };
  }

  _buildLap(data, forcedTimestampSeconds) {
    const lap = {};

    const endTimestampSeconds = data[253] ?? forcedTimestampSeconds;
    if (endTimestampSeconds != null) {
      lap.timestamp = this._convertTimestamp(endTimestampSeconds);
    }

    if (data[2] != null) {
      lap.start_time = this._convertTimestamp(data[2]);
    }

    if (data[3] != null) {
      lap.start_position_lat = this._semicirclesToDegrees(data[3]);
    }

    if (data[4] != null) {
      lap.start_position_long = this._semicirclesToDegrees(data[4]);
    }

    if (data[5] != null) {
      lap.end_position_lat = this._semicirclesToDegrees(data[5]);
    }

    if (data[6] != null) {
      lap.end_position_long = this._semicirclesToDegrees(data[6]);
    }

    if (data[7] != null) {
      lap.total_elapsed_time = data[7] / 1000;
    }

    if (data[8] != null) {
      lap.total_timer_time = data[8] / 1000;
    }

    if (data[9] != null) {
      const distanceMeters = data[9] / 100;
      lap.total_distance = this._convertLength(distanceMeters);
      lap.total_distance_unit = this.options.lengthUnit;
      lap.total_distance_m = distanceMeters;
    }

    if (data[13] != null) {
      const avgSpeedMps = data[13] / 1000;
      lap.avg_speed = this._convertSpeed(avgSpeedMps);
      lap.avg_speed_unit = this.options.speedUnit;
      lap.avg_speed_mps = avgSpeedMps;
    }

    if (data[15] != null) {
      lap.avg_heart_rate = data[15];
    }

    if (data[16] != null) {
      lap.max_heart_rate = data[16];
    }

    if (data[17] != null) {
      lap.avg_cadence = data[17];
    }

    if (data[18] != null) {
      lap.max_cadence = data[18];
    }

    return { type: 'lap', value: lap };
  }

  _buildSession(data, forcedTimestampSeconds) {
    const session = {};

    const endTimestampSeconds = data[253] ?? forcedTimestampSeconds;
    if (endTimestampSeconds != null) {
      session.timestamp = this._convertTimestamp(endTimestampSeconds);
    }

    if (data[2] != null) {
      session.start_time = this._convertTimestamp(data[2]);
    }

    if (data[7] != null) {
      session.total_elapsed_time = data[7] / 1000;
    }

    if (data[8] != null) {
      session.total_timer_time = data[8] / 1000;
    }

    if (data[9] != null) {
      const distanceMeters = data[9] / 100;
      session.total_distance = this._convertLength(distanceMeters);
      session.total_distance_unit = this.options.lengthUnit;
      session.total_distance_m = distanceMeters;
    }

    if (data[25] != null) {
      const avgSpeedMps = data[25] / 1000;
      session.avg_speed = this._convertSpeed(avgSpeedMps);
      session.avg_speed_unit = this.options.speedUnit;
      session.avg_speed_mps = avgSpeedMps;
    }

    if (data[32] != null) {
      session.avg_heart_rate = data[32];
    }

    if (data[33] != null) {
      session.max_heart_rate = data[33];
    }

    if (data[34] != null) {
      session.avg_cadence = data[34];
    }

    if (data[35] != null) {
      session.max_cadence = data[35];
    }

    return { type: 'session', value: session };
  }

  _dispatchMessage(message, result) {
    if (!message) return;
    const { type, value } = message;
    if (type === 'record') {
      result.records.push(value);
    } else if (type === 'lap') {
      result.laps.push(value);
    } else if (type === 'session') {
      result.sessions.push(value);
    }
  }

  _readField(view, offset, size, baseType, littleEndian) {
    const baseTypeNum = baseType & 0x1F;
    const info = this.baseTypeInfo[baseTypeNum];

    if (!info) {
      return null;
    }

    if (info.reader === 'string') {
      return this._readString(view, offset, size);
    }

    const elementSize = info.size || size;
    if (elementSize === 0 || size % elementSize !== 0) {
      return null;
    }

    const count = size / elementSize;
    const values = [];

    for (let i = 0; i < count; i++) {
      const elementOffset = offset + i * elementSize;
      const value = this._readPrimitive(view, elementOffset, info, littleEndian);
      values.push(value);
    }

    return count === 1 ? values[0] : values;
  }

  _readPrimitive(view, offset, info, littleEndian) {
    const method = info.reader;

    if ((method === 'getBigInt64' || method === 'getBigUint64') && typeof view[method] !== 'function') {
      return null;
    }

    let value;

    switch (method) {
      case 'getUint8':
        value = view.getUint8(offset);
        break;
      case 'getInt8':
        value = view.getInt8(offset);
        break;
      case 'getUint16':
        value = view.getUint16(offset, littleEndian);
        break;
      case 'getInt16':
        value = view.getInt16(offset, littleEndian);
        break;
      case 'getUint32':
        value = view.getUint32(offset, littleEndian);
        break;
      case 'getInt32':
        value = view.getInt32(offset, littleEndian);
        break;
      case 'getFloat32':
        value = view.getFloat32(offset, littleEndian);
        if (Number.isNaN(value)) {
          return null;
        }
        break;
      case 'getFloat64':
        value = view.getFloat64(offset, littleEndian);
        if (Number.isNaN(value)) {
          return null;
        }
        break;
      case 'getBigInt64':
        value = view.getBigInt64(offset, littleEndian);
        break;
      case 'getBigUint64':
        value = view.getBigUint64(offset, littleEndian);
        break;
      default:
        return null;
    }

    if (info.invalid != null) {
      if (typeof value === 'bigint') {
        if (value === info.invalid) {
          return null;
        }
      } else if (value === info.invalid) {
        return null;
      }
    }

    return value;
  }

  _readString(view, offset, size) {
    const bytes = [];
    for (let i = 0; i < size; i++) {
      const byte = view.getUint8(offset + i);
      if (byte === 0x00) break;
      bytes.push(byte);
    }
    if (bytes.length === 0) {
      return null;
    }
    if (this._textDecoder) {
      return this._textDecoder.decode(new Uint8Array(bytes));
    }
    return String.fromCharCode(...bytes);
  }

  _convertTimestamp(seconds) {
    const fitEpochOffset = 631065600;
    return new Date((seconds + fitEpochOffset) * 1000);
  }

  _semicirclesToDegrees(value) {
    return value * (180 / Math.pow(2, 31));
  }

  _convertAltitudeRaw(raw) {
    return raw / 5 - 500;
  }

  _convertLength(meters) {
    switch (this.options.lengthUnit) {
      case 'km':
        return meters / 1000;
      case 'mi':
        return meters / 1609.344;
      case 'ft':
        return meters / 0.3048;
      case 'yd':
        return meters / 0.9144;
      default:
        return meters;
    }
  }

  _convertSpeed(mps) {
    switch (this.options.speedUnit) {
      case 'km/h':
        return mps * 3.6;
      case 'mph':
        return mps * 2.23693629;
      case 'knots':
        return mps * 1.94384449;
      default:
        return mps;
    }
  }

  _computeCompressedTimestamp(timeOffset) {
    let newTimestamp = (this.lastTimestampSeconds & ~0x1F) | timeOffset;
    if (newTimestamp <= this.lastTimestampSeconds) {
      newTimestamp += 0x20;
    }
    this.lastTimestampSeconds = newTimestamp;
    return newTimestamp;
  }

  _buildFallbackSession(records) {
    const firstWithTimestamp = records.find((r) => r.timestamp);
    const lastWithTimestamp = [...records].reverse().find((r) => r.timestamp);
    if (!firstWithTimestamp || !lastWithTimestamp) {
      return null;
    }

    const elapsedSeconds = (lastWithTimestamp.timestamp - firstWithTimestamp.timestamp) / 1000;
    const distanceMeters = this._calculateTotalDistanceMeters(records);
    const avgHr = this._calculateAvgHeartRate(records);

    return {
      start_time: firstWithTimestamp.timestamp,
      total_elapsed_time: elapsedSeconds,
      total_timer_time: elapsedSeconds,
      total_distance: this._convertLength(distanceMeters),
      total_distance_unit: this.options.lengthUnit,
      total_distance_m: distanceMeters,
      avg_heart_rate: avgHr
    };
  }

  _calculateTotalDistanceMeters(records) {
    const recordsWithDistance = records.filter((r) => typeof r.distance_m === 'number');

    if (recordsWithDistance.length >= 2) {
      const first = recordsWithDistance[0].distance_m;
      const last = recordsWithDistance[recordsWithDistance.length - 1].distance_m;
      if (last >= first) {
        return last - first;
      }
    }

    if (records.length < 2) {
      return 0;
    }

    let distance = 0;
    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1];
      const curr = records[i];

      if (
        prev.position_lat != null &&
        prev.position_long != null &&
        curr.position_lat != null &&
        curr.position_long != null
      ) {
        distance += this._haversineDistance(
          prev.position_lat,
          prev.position_long,
          curr.position_lat,
          curr.position_long
        );
      }
    }

    return distance;
  }

  _calculateAvgHeartRate(records) {
    let sum = 0;
    let count = 0;
    for (const record of records) {
      if (record.heart_rate != null) {
        sum += record.heart_rate;
        count++;
      }
    }
    return count > 0 ? Math.round(sum / count) : null;
  }

  _haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
};
if (typeof module !== 'undefined') {
  module.exports = FitParser;
}
