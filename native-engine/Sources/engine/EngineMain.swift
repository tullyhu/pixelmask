import Foundation

let BUILD = "native-20260915-2"

@main
struct EngineMain {
    static func main() async throws {
        let port = UInt16(ProcessInfo.processInfo.environment["ENGINE_PORT"] ?? "8765") ?? 8765

        let server = try HTTPServer(port: port) { requestLine, _, body in
            let parts = requestLine.split(separator: " ")
            let method = String(parts[0])
            let path = String(parts[1])

            if method == "OPTIONS" {
                return (200, Data())
            }

            do {
                switch (method, path) {
                case ("GET", "/health"):
                    return (200, HTTPError.json(["ok": true]))

                case ("GET", "/version"):
                    return (200, HTTPError.json(["build": BUILD]))

                case ("POST", "/probe"):
                    let json = try parseBody(body)
                    guard let p = json["path"] as? String else { throw EngineError.badRequest("缺少 path") }
                    return (200, HTTPError.json(try await probe(path: p)))

                case ("POST", "/detect"):
                    let json = try parseBody(body)
                    guard let p = json["path"] as? String else { throw EngineError.badRequest("缺少 path") }
                    let frame = jsonInt(json["frame"]) ?? 0
                    return (200, HTTPError.json(try await detectFaces(path: p, frame: frame)))

                case ("POST", "/track"):
                    let json = try parseBody(body)
                    guard let p = json["path"] as? String else { throw EngineError.badRequest("缺少 path") }
                    var keyframes: [Keyframe] = []
                    for k in json["keyframes"] as? [[String: Any]] ?? [] {
                        keyframes.append(Keyframe(
                            frame: jsonInt(k["frame"]) ?? 0,
                            rectPixels: CGRect(x: jsonNumber(k["x"]) ?? 0, y: jsonNumber(k["y"]) ?? 0,
                                               width: jsonNumber(k["w"]) ?? 0, height: jsonNumber(k["h"]) ?? 0)))
                    }
                    let dense = try await denseBetween(
                        path: p, keyframes: keyframes,
                        from: jsonInt(json["from_frame"]) ?? 0,
                        to: jsonInt(json["to_frame"]) ?? 0)
                    return (200, HTTPError.json(["dense": dense]))

                case ("POST", "/scan"):
                    let json = try parseBody(body)
                    guard let p = json["path"] as? String else { throw EngineError.badRequest("缺少 path") }
                    return (200, HTTPError.json(try await scanFaces(path: p)))

                case ("POST", "/render"):
                    let json = try parseBody(body)
                    guard let project = json["project"] as? [String: Any],
                          let output = json["output"] as? String else {
                        throw EngineError.badRequest("缺少 project/output")
                    }
                    let personSegmentation = json["person_segmentation"] as? Bool ?? false
                    try RenderManager.shared.start(
                        project: project, output: output, personSegmentation: personSegmentation)
                    return (200, HTTPError.json(["job_id": "job"]))

                case ("GET", "/render/status"):
                    return (200, HTTPError.json(RenderManager.shared.status()))

                case ("POST", "/render/cancel"):
                    return (200, HTTPError.json(RenderManager.shared.cancel()))

                case ("POST", "/project/save"):
                    let json = try parseBody(body)
                    guard let p = json["path"] as? String, let data = json["data"] else {
                        throw EngineError.badRequest("缺少 path/data")
                    }
                    let serialized = try JSONSerialization.data(
                        withJSONObject: data, options: [.prettyPrinted, .sortedKeys])
                    try serialized.write(to: URL(fileURLWithPath: p))
                    return (200, HTTPError.json(["ok": true]))

                case ("POST", "/project/load"):
                    let json = try parseBody(body)
                    guard let p = json["path"] as? String else { throw EngineError.badRequest("缺少 path") }
                    let data = try Data(contentsOf: URL(fileURLWithPath: p))
                    let object = try JSONSerialization.jsonObject(with: data)
                    return (200, HTTPError.json(object))

                default:
                    return (404, HTTPError.json(["detail": "not found"]))
                }
            } catch {
                FileHandle.standardError.write(Data("[engine] \(requestLine) error: \(error)\n".utf8))
                return HTTPError.error(error.localizedDescription)
            }
        }

        FileHandle.standardError.write(Data("[engine] native build \(BUILD) listening on \(port)\n".utf8))
        server.start()
        while true {
            try await Task.sleep(for: .seconds(3600))
        }
    }
}

func parseBody(_ body: Data) throws -> [String: Any] {
    guard let object = try? JSONSerialization.jsonObject(with: body),
          let dict = object as? [String: Any] else {
        throw EngineError.badRequest("请求体不是合法 JSON")
    }
    return dict
}
