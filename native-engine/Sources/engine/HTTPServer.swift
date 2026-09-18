import Foundation
import Network

final class HTTPServer {
    typealias Handler = @Sendable (String, [String: String], Data) async -> (Int, Data)

    private let listener: NWListener
    private let handler: Handler

    init(port: UInt16, handler: @escaping Handler) throws {
        self.handler = handler
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
    }

    func start() {
        listener.newConnectionHandler = { [handler] conn in
            conn.start(queue: .global(qos: .userInitiated))
            Self.receive(conn: conn, buffer: Data(), handler: handler)
        }
        listener.start(queue: .global(qos: .userInitiated))
    }

    private static func receive(conn: NWConnection, buffer: Data, handler: @escaping Handler) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Self.parseRequest(buffer) {
                let (method, path, headers, body) = request
                Task {
                    let (status, responseBody) = await handler(method + " " + path, headers, body)
                    Self.respond(conn: conn, status: status, body: responseBody)
                }
                return
            }
            if isComplete || error != nil {
                conn.cancel()
                return
            }
            Self.receive(conn: conn, buffer: buffer, handler: handler)
        }
    }

    private static func parseRequest(_ data: Data) -> (String, String, [String: String], Data)? {
        guard let headerEnd = data.range(of: Data([13, 10, 13, 10])) else { return nil }
        guard let headerText = String(data: data[..<headerEnd.lowerBound], encoding: .utf8) else { return nil }
        var lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0])
        let path = String(parts[1])
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if let colon = line.firstIndex(of: ":") {
                headers[String(line[..<colon]).lowercased()] =
                    String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            }
        }
        let bodyStart = headerEnd.upperBound
        let contentLength = Int(headers["content-length"] ?? "0") ?? 0
        let body = data.suffix(from: bodyStart)
        guard body.count >= contentLength else { return nil }
        return (method, path, headers, body.prefix(contentLength))
    }

    private static func respond(conn: NWConnection, status: Int, body: Data) {
        let reason = status == 200 ? "OK" : (status == 404 ? "Not Found" : "Internal Server Error")
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: application/json\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Access-Control-Allow-Origin: *\r\n"
        head += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        head += "Access-Control-Allow-Headers: content-type\r\n"
        head += "Connection: close\r\n\r\n"
        var payload = Data(head.utf8)
        payload.append(body)
        conn.send(content: payload, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }
}

enum HTTPError {
    static func json(_ object: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    }

    static func error(_ message: String) -> (Int, Data) {
        (500, json(["detail": message]))
    }
}
