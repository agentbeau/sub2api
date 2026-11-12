# Third-party notices

sub2api is built on open-source components. Product branding does not remove their
copyright, license or source attribution.

- The original gateway is from [PlaygrndLabs/sub2api](https://github.com/PlaygrndLabs/sub2api), under the [MIT license](LICENSE).
- The retained Go provider engine is [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Its original package names, protocol identifiers and stored-data formats remain where required for compatibility. The image build copies its license from the exact checked-out source into `/usr/share/licenses/sub2api/provider-LICENSE`.
- The provider dashboard derives from [Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center), copyright 2026 Router-For.ME, under the MIT license in [container/brand-panel/UPSTREAM_LICENSE](container/brand-panel/UPSTREAM_LICENSE). The build changes product display strings, product artwork and metadata readers. Bundled dependency license comments are preserved.
- Rust crates and the build-time TypeScript compiler retain their respective licenses. The compiler is used only in the dashboard build stage.

Actual provider names, plugin authors and provider-required protocol metadata
identify their real sources and are not replaced with sub2api claims of authorship.
