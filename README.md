# Superborrow — Faz 1

Antigravity / VS Code için Rust + TypeScript tamamlama motorunun ilk fazı.
Bu aşama iki yönlü iletişim ve süreç yönetimini kurar. Gerçek model tamamlaması,
AST/FIM bağlamı, hibrit yönlendirme, debounce, ghost text ve model keşfi sonraki
fazlardadır; gecikme hedefleri henüz ölçülmedi.

## Yapı

```text
core-rust/          Rust çekirdeği ve sınırlı Content-Length taşıyıcısı
extension/src/     Tipli protokol, çocuk süreç köprüsü ve eklenti giriş noktası
extension/test/    Gerçek Rust süreciyle uçtan uca köprü testleri
docs/protocol.md   Mesaj sözleşmesi ve hata kodları
.vscode/           F5 geliştirme başlatıcısı ve derleme görevleri
```

## Derleme ve doğrulama

Rust (edition 2024), Node.js 22+ ve npm gerekir. Proje kökünde:

```powershell
cargo build --manifest-path core-rust/Cargo.toml
npm --prefix extension ci
npm --prefix extension run compile
cargo test --manifest-path core-rust/Cargo.toml
cargo clippy --manifest-path core-rust/Cargo.toml --all-targets -- -D warnings
npm --prefix extension test
```

Geliştirme için VS Code uyumlu editörde bu klasörü açıp **F5 → Superborrow Extension** ile
Extension Development Host başlat. Komut paletinden **Superborrow: Check Bridge**
çalıştır. Başarılı bağlantı bildirimi ve Superborrow Output kanalında protokol
sürümü görünür. Aktif belge varsa tek bir tam snapshot gönderilir. Sürekli belge
dinleyicileri ve inline completion kaydı Faz 4 kapsamındadır.

## Antigravity IDE'ye kurulum (Windows x64)

```powershell
npm --prefix extension run package:windows
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension "$PWD\packages\superborrow-0.1.0-win32-x64.vsix" --force
```

Paket release Rust binary'sini ve gerekli Node bağımlılıklarını içerir.
Antigravity IDE açıldığında köprü otomatik başlar; durum çubuğunda
**Superborrow: Connected** görünür. Gerekirse **Superborrow: Check Bridge** ile
yeniden bağlanılabilir. Açık bir editöre kurulum yaptıysan pencereyi yeniden yükle.

Geliştirme yolu otomatik bulunur. Farklı binary için mutlak
`superborrow.corePath` ayarlanabilir. Güvenilmeyen çalışma
alanlarında etkinleşmez. Rust süreci shell kullanmadan ve Windows'ta pencere
açmadan başlatılır; eklenti kapanınca sonlandırılır.

Testlerde kullanılan IDE adaptörü yalnızca test içinde sabit yanıt döndürür.
Eklentide model adaptörü henüz uygulanmamıştır. `local` modu açık hata döndürür;
`ide`/`hybrid` köprüyü sınar. Ollama/llama.cpp veya Antigravity'nin iç servislerine
bu fazda bağlantı yapılmaz.

Ayrıntılar için [protokol sözleşmesi](docs/protocol.md).

Kaynak deposu: [dRafaleD/superborrow](https://github.com/dRafaleD/superborrow)
(private). Derleme çıktıları ve yerel binary'ler Git'e eklenmez; VSIX paketleme
komutu her checkout'ta yeniden üretilebilir.
