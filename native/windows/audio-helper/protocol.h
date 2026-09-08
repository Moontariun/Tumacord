// Protocolo entre o helper nativo e o processo principal do Tumacord.
//
// Um único canal binário (stdout) carrega dois tipos de quadro: o PCM da
// mistura e os eventos em JSON. Misturar JSON com áudio em texto obrigaria a
// escapar amostras; separar em dois descritores obrigaria o lado Node a
// costurar duas ordens de chegada. Um quadro com cabeçalho resolve os dois.
//
// Cabeçalho (8 bytes, little-endian):
//   0..1  'T','A'
//   2     tipo (1 = PCM float32 estéreo 48 kHz, 2 = evento JSON UTF-8)
//   3     reservado (0)
//   4..7  tamanho do payload em bytes
//
// Os comandos chegam por stdin, uma linha por comando, em texto simples. Não
// há JSON de entrada de propósito: o helper nunca precisa de um analisador,
// e o lado que decide o que capturar é o JavaScript, que é onde a política
// pode ser testada.
#pragma once

#include <windows.h>
#include <cstdint>
#include <string>

namespace tumacord {

constexpr uint8_t kFrameTypePcm = 1;
constexpr uint8_t kFrameTypeEvent = 2;
constexpr uint32_t kSampleRate = 48000;
constexpr uint16_t kChannels = 2;
// 10 ms por quadro: curto o bastante para a latência não incomodar e longo o
// bastante para o custo por mensagem no IPC ser irrelevante.
constexpr uint32_t kFramesPerBlock = kSampleRate / 100;

void WriteFrame(uint8_t type, const void* payload, uint32_t length);
void WriteEvent(const std::string& json);
std::string JsonEscape(const std::wstring& value);
std::string Narrow(const std::wstring& value);

}  // namespace tumacord
