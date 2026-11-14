# Superborrow

Antigravity IDE / VS Code için Rust bağlam motoru ve TypeScript istemcisiyle
yerel veya IDE modeli kullanan hibrit kod tamamlama. Sürüm **0.2.0**.

## Neler çalışıyor?

- İmleç öncesi/sonrası bağlamla FIM; Qwen ve Codestral token düzenleri.
- Rust, TypeScript/TSX, JavaScript/JSX ve Python için artımlı tree-sitter analizi;
  diğer dillerde metin bağlamı. Açık belgelerden sembol imzaları ve son 10 düzenleme.
- llama.cpp `/infill`, Ollama `/api/generate`, yerel OpenAI uyumlu `/v1/completions`.
  SSE/NDJSON akışı, paylaşılan HTTP istemcisi, iptal ve zaman aşımı.
- Hayalet metin, belge olayları, debounce, kısa ömürlü öneri önbelleği ve mod seçici.
- `vscode.lm` model seçimi, keşif komutu ve açık sözleşmeli özel eklenti adaptörü.
- **Suggest Next Edit**: seçili kod veya mevcut satır için öneri, fark önizlemesi,
  kullanıcı uygulaması ve arada değişen belge için sürüm kontrolü.

Next Edit bu sürümde seçili aralıkla sınırlıdır; sonraki düzenleme konumunu
otomatik tahmin etmez ve birden fazla dosyayı düzenlemez. Supermaven düzeyinde
gecikme/kalite iddiası yoktur. IDE'nin kendi sohbet modelleri `vscode.lm` üzerinden
açılmıyorsa seçilemez; yerel sağlayıcı kullanılabilir.

## Kurulum ve geliştirme

Rust edition 2024, Node.js 22+ ve npm gerekir. Windows'ta C/C++ derleme araçları
(tree-sitter için MSVC Build Tools), Linux'ta C derleyicisi gerekir.

```powershell
npm --prefix extension ci --ignore-scripts
cargo build --locked --manifest-path core-rust/Cargo.toml
npm --prefix extension test
cargo test --locked --manifest-path core-rust/Cargo.toml
cargo clippy --locked --manifest-path core-rust/Cargo.toml --all-targets -- -D warnings
npm --prefix extension run package:windows
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension "$PWD\packages\superborrow-0.2.0-win32-x64.vsix" --force
```

Paket Windows x64 Rust çekirdeğini içerir. Kurulumdan sonra **Developer: Reload
Window** çalıştır. Güvenilen çalışma alanında motor otomatik başlar. Geliştirmede
bu klasörü açıp F5 kullanılabilir. Farklı binary: `superborrow.corePath`.

## Yerel model ayarı

Önceden indirilmiş FIM uyumlu bir model ve çalışan sunucu gerekir. Eklenti model
indirmez ve sunucuyu kendiliğinden kurmaz/başlatmaz. Ollama örneği:

```json
{
  "superborrow.mode": "hybrid",
  "superborrow.localApi": "ollama",
  "superborrow.endpoint": "http://127.0.0.1:11434/api/generate",
  "superborrow.model": "qwen2.5-coder:7b",
  "superborrow.fimFormat": "qwen"
}
```

llama.cpp için `localApi: "llamaInfill"`,
`endpoint: "http://127.0.0.1:8080/infill"`; model tokenizer'ını sunucu seçer.
OpenAI uyumlu yerel sunucu için `localApi: "openAi"`, tam `/v1/completions`
adresi ve model adı gerekir. Bu adaptör sohbet `/chat/completions` protokolünü
kullanmaz. Codestral ham token düzeni `fimFormat: "codestral"` ile seçilir.

Durum çubuğuna tıklayarak **Hybrid → Local → Antigravity** geçişi yapılır.
Local yalnızca yerel modele gider. Hybrid basit satırlarda yereli, blok başlangıcı,
büyük bağlam ve Next Edit için seçilmiş IDE modelini tercih eder. Sağlayıcı hata
verirse kullanılabilir diğer sağlayıcıyı dener. Yerel gecikme bütçesi aşıldığında
IDE seçiliyse ona geçer. IDE modeli için önce **Antigravity Tab: Select IDE Model**
çalıştır; ilk izin akışı bu kullanıcı komutunda gerçekleşir.

## Komutlar

| Komut | İşlev |
| --- | --- |
| Superborrow: Check Bridge | Bağlantıyı yeniden kur |
| Antigravity Tab: Switch Mode | Modlar arasında geç |
| Antigravity Tab: Pause / Resume | Tamamlamayı ve belge toplamayı durdur/başlat |
| Antigravity Tab: Select IDE Model | IDE modeli veya yapılandırılmış adaptörü seç |
| Antigravity Tab: Inspect Available Models | Modelleri, eklenti export adlarını ve aday komutları listele |
| Antigravity Tab: Suggest Next Edit | Seçili kod / mevcut satır için fark önizlemesi |
| Antigravity Tab: Show Diagnostics | Bağlantı ve hata kayıtlarını aç |

Hayalet metni editörün standart kabul tuşuyla (genellikle Tab) kabul edebilirsin.
Diğer tamamlama eklentileriyle aynı anda çalışması önerilerin görünmesini
etkileyebilir. IDE modunda model seçilmemişse açıklayıcı hata tanılarda görünür.

## Bağlam ve sınırlar

En çok 16 açık uygun belge senkronize edilir; aktif belge önceliklidir. Dosya başı
512 KiB, çekirdekte toplam 8 MiB sınırı vardır. Geçmiş ve prompt sınırlandırılır;
tam repo taraması yapılmaz. `.env*`, `*.pem`, `*.key`, `.git`, `node_modules`,
`target`, `dist` varsayılan olarak hariçtir; `superborrow.exclude` düzenlenebilir.
Bu dosya adı filtresi içerikteki tüm gizli bilgileri saptayan bir tarayıcı değildir.

Bağlam ve öneriler yalnızca bellekte tutulur. Prompt/kaynak metni loglanmaz.
Yerel HTTP istemcisi yalnızca loopback adres kabul eder; yönlendirme/proxy yoktur.
IDE/Hybrid modunda seçilmiş IDE sağlayıcısına kod bağlamı gönderilebilir.
Özel proje notları `superborrow.projectContext` ile açıkça girilir.

`maxContextBytes`, `maxTokens`, `debounceMs`, `requestTimeoutMs` ayarlanabilir.
İptal, değişen belge, kapanan dosya ve yeni istek eski yanıtların gösterilmesini
engeller. Next Edit sınırı `min(16 KiB, maxContextBytes / 4)` seçili UTF-8 metnidir.
IDE API'si standart bir çıktı token sınırı sunmadığından byte sınırı uygulanır.

## Doğrulama

CI, Windows ve Ubuntu üzerinde Rust format/Clippy/testleri, derlemeyi ve gerçek
Rust sürecine bağlanan Node testlerini çalıştırır. Yerel sağlayıcı testleri
kontrollü HTTP sunucularını kullanır; dış modele ihtiyaç duymaz.

Gerçek Ollama testi (model önceden kurulu olmalı):

```powershell
npm --prefix extension run smoke:local
```

Bu test dış model indirmez; `SUPERBORROW_MODEL` ile başka kurulu model seçilebilir.
[Ölçüm notları](docs/validation.md), [mimari](docs/architecture.md),
[protokol](docs/protocol.md), [IDE adaptör sözleşmesi](docs/ide-adapter.md).

Özel kaynak deposu: [dRafaleD/superborrow](https://github.com/dRafaleD/superborrow).
