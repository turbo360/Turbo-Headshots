// Turbo Headshots Sidecar
// JSON-RPC over stdin/stdout. One request per line; one response per line.
//
// Methods:
//   detectFace      { path: String }
//   foregroundMask  { path: String, outputPath: String }
//   qualityCheck    { path: String }
//
// Spawned once by Electron main; stays alive for the life of the app.

import Foundation

struct RPCRequest: Decodable {
    let id: Int
    let method: String
    let params: [String: AnyCodable]?
}

struct RPCResponse: Encodable {
    let id: Int
    let result: AnyCodable?
    let error: String?
}

let stdin = FileHandle.standardInput
let stdout = FileHandle.standardOutput
let stderr = FileHandle.standardError

func writeLine(_ data: Data) {
    stdout.write(data)
    stdout.write("\n".data(using: .utf8)!)
}

func respond(id: Int, result: Any? = nil, error: String? = nil) {
    let resp: [String: Any] = [
        "id": id,
        "result": result as Any,
        "error": error as Any
    ]
    if let data = try? JSONSerialization.data(withJSONObject: resp, options: []) {
        writeLine(data)
    }
}

func logErr(_ msg: String) {
    stderr.write("[sidecar] \(msg)\n".data(using: .utf8)!)
}

logErr("ready")

while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = req["id"] as? Int,
          let method = req["method"] as? String else {
        continue
    }
    let params = req["params"] as? [String: Any] ?? [:]

    do {
        switch method {
        case "detectFace":
            guard let path = params["path"] as? String else {
                respond(id: id, error: "missing path")
                continue
            }
            let result = try FaceDetector.detect(path: path)
            respond(id: id, result: result)

        case "foregroundMask":
            guard let path = params["path"] as? String,
                  let outputPath = params["outputPath"] as? String else {
                respond(id: id, error: "missing path or outputPath")
                continue
            }
            try ForegroundMask.generate(path: path, outputPath: outputPath)
            respond(id: id, result: ["ok": true])

        case "qualityCheck":
            guard let path = params["path"] as? String else {
                respond(id: id, error: "missing path")
                continue
            }
            let result = try QualityChecks.evaluate(path: path)
            respond(id: id, result: result)

        case "ping":
            respond(id: id, result: ["ok": true, "version": "1.0"])

        default:
            respond(id: id, error: "unknown method: \(method)")
        }
    } catch {
        respond(id: id, error: "\(error)")
    }
}

// AnyCodable shim so we can pass through arbitrary JSON values.
struct AnyCodable: Codable {
    let value: Any
    init(_ value: Any) { self.value = value }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(Int.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode(String.self) { value = v }
        else { value = NSNull() }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let v as Bool: try c.encode(v)
        case let v as Int: try c.encode(v)
        case let v as Double: try c.encode(v)
        case let v as String: try c.encode(v)
        default: try c.encodeNil()
        }
    }
}
