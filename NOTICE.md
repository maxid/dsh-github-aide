# NOTICE

`dsh-github-aide` merges behaviour and portions of the implementation of two
DeepSeek Harness plugins:

- **[dsh-github-sync](https://github.com/s-huizhuy-u/dsh-github-sync)** — MIT,
  copyright the dsh-github-sync authors. Source of the workspace publish flow,
  the credential-store token handling, the GitHub REST client, the git layer,
  the settings namespace, and the harness-update notice.
- **[dsh-github-upload](https://github.com/3164481170/dsh-github-upload)** —
  published without a license file by its author. Source of the project
  preflight, stack detection, `.gitignore` generation, secret scan, and the web
  panel; those behaviours were reimplemented here rather than copied.

Both upstream projects remain under their own licenses and copyrights. This
repository is distributed under the MIT license; see [LICENSE](LICENSE).
