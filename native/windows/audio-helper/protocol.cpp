#include "protocol.h"

#include <cstdio>
#include <mutex>
#include <vector>

namespace tumacord {
namespace {

std::mutex g_writeMutex;

bool WriteAll(HANDLE handle, const uint8_t* data, size_t length) {
  size_t written = 0;
  while (written < length) {
    DWORD chunk = 0;
    const size_t left = length - written;
    const DWORD remaining = static_cast<DWORD>(left > 0x10000 ? 0x10000 : left);
    if (!WriteFile(handle, data + written, remaining, &chunk, nullptr) || chunk == 0) return false;
    written += chunk;
  }
  return true;
}

}  // namespace

void WriteFrame(uint8_t type, const void* payload, uint32_t length) {
  uint8_t header[8] = {'T', 'A', type, 0, 0, 0, 0, 0};
  header[4] = static_cast<uint8_t>(length & 0xff);
  header[5] = static_cast<uint8_t>((length >> 8) & 0xff);
  header[6] = static_cast<uint8_t>((length >> 16) & 0xff);
  header[7] = static_cast<uint8_t>((length >> 24) & 0xff);
  const HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  std::lock_guard<std::mutex> guard(g_writeMutex);
  // Cabecalho e payload precisam sair juntos: dois WriteFile concorrentes
  // intercalariam um evento no meio de um bloco de PCM e o decodificador do
  // outro lado perderia o sincronismo para sempre.
  if (!WriteAll(out, header, sizeof(header))) return;
  if (length) WriteAll(out, static_cast<const uint8_t*>(payload), length);
}

void WriteEvent(const std::string& json) {
  WriteFrame(kFrameTypeEvent, json.data(), static_cast<uint32_t>(json.size()));
}

std::string Narrow(const std::wstring& value) {
  if (value.empty()) return std::string();
  const int needed = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), &out[0], needed, nullptr, nullptr);
  return out;
}

std::string JsonEscape(const std::wstring& value) {
  const std::string utf8 = Narrow(value);
  std::string out;
  out.reserve(utf8.size() + 8);
  for (const char raw : utf8) {
    const unsigned char character = static_cast<unsigned char>(raw);
    if (character == static_cast<unsigned char>('"')) {
      out += "\\\"";
    } else if (character == static_cast<unsigned char>('\\')) {
      out += "\\\\";
    } else if (character == 0x0a) {
      out += "\\n";
    } else if (character == 0x0d) {
      out += "\\r";
    } else if (character == 0x09) {
      out += "\\t";
    } else if (character < 0x20) {
      char buffer[8];
      sprintf_s(buffer, sizeof(buffer), "\\u%04x", static_cast<unsigned int>(character));
      out += buffer;
    } else {
      out += raw;
    }
  }
  return out;
}

}  // namespace tumacord
