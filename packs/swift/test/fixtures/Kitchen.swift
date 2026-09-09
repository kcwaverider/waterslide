import Foundation
import SwiftUI
@testable import Helpers

typealias P = StubProvider

struct Endpoint {
    let path: String
    let method: String

    var request: URLRequest {
        guard let url = URL(string: APIClient.shared.baseURL + path) else {
            fatalError("Invalid URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        return request
    }
}

class APIClient {
    static let shared = APIClient()
    static let session: URLSession = URLSession(configuration: .default)
    private(set) var baseURL: String = "https://x"

    func request<T: Decodable>(_ endpoint: Endpoint) async throws -> T {
        return try await request(endpoint.request)
    }

    func request<T: Decodable>(_ urlRequest: URLRequest) async throws -> T {
        let (data, _) = try await APIClient.session.data(for: urlRequest)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct Note: Codable {
    let id: String
    var title: String?
    let author: Author
    let tags: [String]
}

struct Author: Codable {
    let name: String
}

final class Logger {
    static let shared = Logger()
    func log(_ s: String) {}
    func warn(_ s: String) {}
    func error(_ s: String) {}
}

final class NoteService {
    static let shared = NoteService()
    private let apiClient = APIClient.shared
    private let log = Logger.shared

    func list() async throws -> [Note] {
        let endpoint = Endpoint(path: "/api/notes?archived=false", method: "GET")
        return try await apiClient.request(endpoint) as [Note]
    }

    func get(id: String) async throws -> Note {
        try await apiClient.request(Endpoint(path: "/api/notes/\(id)", method: "GET"))
    }

    func login(username: String) async throws -> Note? {
        var request = URLRequest(url: URL(string: apiClient.baseURL + "/api/auth/token")!)
        request.httpMethod = "POST"
        let (data, response) = try await APIClient.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            log.log("failed")
            return nil
        }
        if data.isEmpty {
            log.warn("empty")
        } else {
            log.log("ok")
        }
        do {
            return try JSONDecoder().decode(Note.self, from: data)
        } catch {
            log.error("decode")
            throw error
        }
    }

    private func multipart(path: String) throws -> URLRequest {
        var request = URLRequest(url: URL(string: "\(apiClient.baseURL)\(path)")!)
        request.httpMethod = "POST"
        return request
    }

    func upload() async throws {
        let request = try multipart(path: "/api/notes/upload")
        do {
            _ = try await apiClient.request(request) as Note
            log.log("uploaded")
        } catch {
            log.error("upload failed")
        }
    }
}

extension NoteService {
    func archive(id: String) async throws {
        _ = try await apiClient.request(Endpoint(path: "/api/notes/\(id)/archive", method: "POST")) as Note
    }
}

extension Color {
    static let brand = Color.red
}

struct NotesView: View {
    @StateObject private var viewModel = NotesViewModel()
    @State private var query = ""

    var body: some View {
        VStack {
            Text("Notes")
            Button("Reload") {
                Task { await viewModel.reload() }
            }
            Button(action: { viewModel.clear() }) {
                Text("Clear")
            }
            Button {
                viewModel.clear()
            } label: {
                Text("Clear 2")
            }
            TextField("Search", text: $query)
                .onSubmit { viewModel.search(query) }
            Button("Sync", action: sync)
            Button(action: viewModel.clear) { Text("Clear 3") }
        }
        .task {
            await viewModel.reload()
        }
        .onAppear { viewModel.track() }
        .onChange(of: query) { _, new in viewModel.search(new) }
        .refreshable { await viewModel.reload() }
    }

    private func helper() {
        viewModel.clear()
    }

    private func sync() {
        Task { await viewModel.reload() }
    }
}

@MainActor
final class NotesViewModel: ObservableObject {
    @Published var notes: [Note] = []
    func reload() async {
        do { notes = try await NoteService.shared.list() } catch { notes = [] }
    }
    func clear() { notes = [] }
    func search(_ q: String) {}
    func track() { P.shared.track() }
}

@main
struct KitchenApp: App {
    var body: some Scene {
        WindowGroup { NotesView() }
    }
}
