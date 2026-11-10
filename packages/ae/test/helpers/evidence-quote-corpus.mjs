// Corpora that tune the evidence_quote screen. PASS_QUOTES are ordinary
// single-line failure output that must be accepted and shown unchanged;
// REFUSED_QUOTES are secret shapes that must be refused on write and
// withheld on read. Secret-shaped values are assembled at run time so no
// credential-shaped literal sits in the source.

const j = (...parts) => parts.join('');
const BODY36 = 'A1b2C3d4E5'.repeat(4).slice(0, 36);
const MIXED24 = 'x9Kq2Lm7Np4Rs8Tv3Wy6Za1B';
const HEX40 = '3f2c9a1e8b7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f';

export const PASS_QUOTES = [
  // ESLint, tsc, Prettier
  "/srv/app/src/users.ts:42:18  error  'user' is possibly 'undefined'  @typescript-eslint/no-unnecessary-condition",
  'src/components/Button.tsx(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
  'error TS2307: Cannot find module \'@acme/shared-utils/v2\' or its corresponding type declarations.',
  '  14:7  warning  Unexpected console statement  no-console',
  '[warn] src/routes/orders/checkout-summary.test.ts Code style issues found. Run Prettier to fix.',
  // Go
  '    retry_test.go:27: got 4, want 3',
  '--- FAIL: TestOrderService_RetryWithBackoff (0.35s)',
  'panic: runtime error: index out of range [5] with length 5',
  'goroutine 18 [running]: github.com/acme/orders/internal/queue.(*Worker).Run(0xc000123456)',
  'FAIL\tgithub.com/acme/orders/internal/queue\t0.412s',
  // Rust
  'error[E0308]: mismatched types',
  "thread 'tests::parses_header_v2' panicked at src/parser.rs:118:9:",
  '  --> src/main.rs:23:15',
  'error: could not compile `orders-service` (lib test) due to 2 previous errors',
  // Jest / Vitest / Mocha
  'expect(received).toBe(expected) // Object.is equality',
  '  \u25cf OrderService \u203a retries after a 503 response',
  ' FAIL  src/__tests__/order-total.test.ts > computes totals with discount codes',
  'Tests:       1 failed, 41 passed, 42 total',
  '    at Object.<anonymous> (/home/ci/work/app/src/__tests__/order2.test.ts:12:5)',
  'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 41 !== 42',
  // pytest / Python
  'E       AssertionError: assert 41 == 42',
  'FAILED tests/test_orders.py::test_retry_after_503_backoff - assert 2 == 3',
  'AssertionError: assert compute(data) == expected_checksum_value',
  'ModuleNotFoundError: No module named \'orders_service.adapters.postgres_v2\'',
  '  File "/usr/lib/python3.12/site-packages/django/db/models/query.py", line 916, in get',
  'TypeError: unsupported operand type(s) for +: \'int\' and \'NoneType\'',
  // JUnit / Java / Kotlin
  'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "com.example.User.getId()" because "user" is null',
  'org.opentest4j.AssertionFailedError: expected: <200> but was: <503>',
  '\tat com.example.orders.OrderServiceTest.retriesAfterFailure(OrderServiceTest.java:87)',
  '\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
  'com.example.app.v1.OrderService$Companion.create(OrderService.kt:41)',
  '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test (default-test) on project orders',
  // npm / yarn / pnpm / node
  'npm ERR! 404 Not Found - GET https://registry.npmjs.org/@acme%2fwidget - Not found',
  'npm ERR! code ERESOLVE unable to resolve dependency tree',
  'error An unexpected error occurred: "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz: ETIMEDOUT".',
  ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date',
  'TypeError: Cannot read properties of undefined (reading \'id\')',
  'Error: connect ECONNREFUSED 127.0.0.1:5432',
  'node:internal/modules/cjs/loader:1228 throw err; Error: Cannot find module \'/app/node_modules/.bin/vitest\'',
  'Error [ERR_REQUIRE_ESM]: require() of ES Module /app/node_modules/chalk/source/index.js not supported.',
  'SyntaxError: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
  // Docker / CI
  'ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
  'docker: Error response from daemon: pull access denied for acme/orders-api, repository does not exist.',
  'Step 7/12 : RUN pip install -r requirements.txt',
  ' => ERROR [build 5/8] RUN go build -o /out/server ./cmd/server                                  2.1s',
  'ghcr.io/acme/orders-api:1.4.2-alpine3.19: digest: sha256:9b2f6c1e3d4a4f5b8c7d1e2f3a4b5c6d9b2f6c1e3d4a4f5b8c7d1e2f3a4b5c6d size: 1573',
  // git
  `fatal: bad object ${HEX40}`,
  'error: failed to push some refs to \'https://github.com/acme/orders.git\'',
  'CONFLICT (content): Merge conflict in src/orders/checkout_summary_v2.py',
  `HEAD is now at ${HEX40.slice(0, 7)} fix retry backoff for 503`,
  '--- a/config/settings.production.yml',
  '+  retries: 3   # was 0',
  // Identifiers, paths, URLs, hashes, times
  'Error: order 9b2f6c1e-3d4a-4f5b-8c7d-1e2f3a4b5c6d not found (404)',
  'test_user_login_flow_v2 failed after 3 retries',
  'loading com.example.app.v1 from node_modules/.bin/acme-cli',
  'C:\\Users\\builder\\AppData\\Local\\Temp\\test-12345\\orders.spec.js:10:5',
  'D:\\a\\orders\\orders\\src\\Orders.Api\\Controllers\\OrdersController.cs(42,17): error CS1002: ; expected',
  'GET https://api.example.com/v2/orders/12345?include=items&page=2 returned 500',
  'see https://github.com/acme/orders/blob/main/src/queue/worker_pool.ts#L118',
  `see https://github.com/acme/orders/commit/${HEX40}`,
  'assets/main.a1b2c3d4e5f6a7b8.js exceeds the size budget (245 KiB > 200 KiB)',
  '2026-11-10T14:23:45.123Z ERROR orders.retry attempt=3 status=503',
  'integrity check failed for sha512-q3Kd9 expected sha1-2f3e',
  'Expected 1699999999999 to be less than 1600000000000',
  'value 6.02214076e23 out of range for float32',
  'checksum mismatch: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'Error: ENOSPC: no space left on device, write',
  'yarn run v1.22.19',
  // Non-English messages and paths
  'Ошибка: превышено время ожидания соединения',
  "open 'отчёт.pdf': no such file or directory",
  "ENOENT: no such file or directory, open '/home/user/документы/report.txt'",
  '/home/user/отчёт_за_2024_год_финал.pdf: permission denied',
  'Σφάλμα: Δt=0.5 υπερβαίνει το όριο',
  'timeout after 5μs (limit 3μs)',
  'R1=10Ω expected, measured 12Ω',
  'שגיאה: הקובץ לא נמצא (קוד 404)',
  'خطأ: انتهت مهلة الاتصال بالخادم 503',
  'ข้อผิดพลาด: ไม่พบไฟล์ config.json',
  'त्रुटि: फ़ाइल नहीं मिली',
  'ファイルconfig.jsonが見つかりません',
  '错误：无法连接数据库 (code 42)',
  '오류: 파일을 찾을 수 없습니다',
  'błąd_404: nie znaleziono zasobu',
  'Zażółć gęślą jaźń: test nie powiódł się',
  'kullanıcı_id=5 bulunamadı',
  'i̇stanbul_şube_kodu=34 geçersiz',
  '/home/søren/app/test.js:10',
  'Ålesund_rapport_2024.xlsx mangler',
  'Straße nicht gefunden',
  'café_1 failed: résumé.pdf missing',
  // Emoji, keycaps, variation selectors, joiners
  'Warning \u26a0\ufe0f test failed',
  'step 1\ufe0f\u20e3 failed, step 2\ufe0f\u20e3 skipped',
  'sync \u2194\ufe0e retry',
  'dev \u{1f468}\u200d\u{1f4bb} failed',
  'wave \u{1f44b}\u{1f3fd}\u200d\u{1f4bb} hi',
  '\u274c 3 tests failed \u2705 39 passed',
  // Short tokens and plain key-value output that is not a credential
  'TOKEN_LIMIT exceeded: 4097 > 4096',
  'max_tokens must be at most 8192',
  'Unexpected token < in JSON at position 0',
  'retry budget exhausted for job orders-sync-7f3a2',
];

// Ordinary output the shape rule refuses by design: a token of 20 or more
// characters with a long or mixed-case segment that mixes letters and digits
// cannot be told from a credential. Quote a different line.
export const REFUSED_ORDINARY = [
  'Request-Id: 01HF3Z8K9Q7W2X4Y6V5T3R1P0N failed',
  'at com.example.OrderServiceTest.shouldRetry3TimesWithBackoff(OrderServiceTest.java:12)',
];

export const REFUSED_QUOTES = [
  // Glued to word characters on either side
  ['ghp trailing word', j('auth failed ghp_', BODY36, '_x')],
  ['ghp leading word', j('TOKEN_ghp_', BODY36)],
  ['ghp letter glued', j('xghp_', BODY36)],
  ['AKIA with suffix', j('key AKIA', 'IOSFODNN7EXAMPLE_prod')],
  ['AKIA bare', j('AKIA', 'IOSFODNN7EXAMPLE')],
  ['AKIA glued', j('keyAKIA', 'IOSFODNN7EXAMPLE')],
  // Vendor tokens
  ['github pat', j('github_pat_', '11ABCDEFG0', MIXED24, MIXED24)],
  ['github oauth', j('gho_', BODY36)],
  ['gitlab', j('glpat-', 'xY9z8W7v6U5t4S3r2Q1p')],
  ['slack bot', j('xoxb-', '1234567890123-1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx')],
  ['slack webhook path', j('https://hooks.slack.com/services/T0', '1ABCDEF/B0', '2GHIJKL/', MIXED24)],
  ['google api key', j('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6')],
  ['stripe live', j('sk_live_', '51H8xY2eZvKYlo2C', 'aB3dE4fG5hI6')],
  ['stripe restricted', j('rk_live_', MIXED24)],
  ['openai project', j('sk-proj-', MIXED24, 'Qw3Er5Ty7Ui9')],
  ['openai legacy', j('sk-', MIXED24, 'Qw3Er5Ty7Ui9')],
  ['anthropic', j('sk-ant-api03-', MIXED24, MIXED24)],
  ['huggingface', j('hf_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ', '0123456')],
  ['npm', j('npm_', MIXED24, 'Ab3De5Gh7Jk9')],
  ['pypi', j('pypi-', 'AgEIcHlwaS5vcmcCJ', MIXED24)],
  ['twilio', j('SK', '0123456789abcdef0123456789ABCDEF')],
  ['sendgrid', j('SG.', 'aB3dE4fG5hI6jK7lM8nO9p', '.', 'qR1sT2uV3wX4yZ5aB6cD7eF8gH9iJ0kL1mN2oP3qR4s')],
  // Structured secrets
  ['jwt', j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
  ['private key header', j('-----BEGIN ', 'RSA PRIVATE KEY-----')],
  ['openssh key header', j('-----BEGIN ', 'OPENSSH PRIVATE KEY-----')],
  ['postgres url', j('connect failed postgres://orders:', 'hunter2pass', '@db.internal:5432/orders')],
  ['mongodb url', j('mongodb+srv://admin:', 'S3cretPass', '@cluster0.example.net/test')],
  ['bearer', j('Authorization: Bearer ', MIXED24)],
  ['basic auth', j('Authorization: Basic ', 'dXNlcjpwYXNzd29yZA==')],
  // Key-value secrets
  ['password kv', j('password=', 'correct-horse-battery')],
  ['token kv', j('token: ', 'abcdefghijklmnopqrstuvwxyz')],
  ['api key kv', j('API_KEY="', 'k3y-material-goes-here', '"')],
  ['aws secret kv', j('aws_secret_access_key = ', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')],
  // Base64 secret with slashes, and look-alikes
  ['aws secret bare', j('secret rejected: ', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')],
  ['cyrillic er', j('gh\u0440_', BODY36)],
  ['cyrillic A', j('\u0410KIA', 'IOSFODNN7EXAMPLE')],
  ['cherokee a', j('\u13aaKIA', 'IOSFODNN7EXAMPLE')],
  ['latin small capital', j('ghp_\u1d00', BODY36.slice(1))],
  ['fullwidth', '\uff21\uff2b\uff29\uff21\uff29\uff2f\uff33\uff26\uff2f\uff24\uff2e\uff2e\uff17\uff25\uff38\uff21\uff2d\uff30\uff2c\uff25'],
  ['combining overlay', j('ghp_', BODY36.slice(0, 10), '\u0336', BODY36.slice(10))],
  ['generic random', j('session ', MIXED24, ' expired')],
];
