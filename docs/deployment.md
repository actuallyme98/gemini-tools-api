# CI/CD và deploy trên server EziHubb

Hai repository dùng GitHub Actions → GHCR → SSH → Docker Compose, cùng cách build/pull image của EziHubb. API sở hữu cấu hình stack và deployment engine; frontend gọi engine đã cài trên server. Server không phải checkout source hay chạy npm build mỗi lần phát hành.

## Cấu hình đã đối chiếu

| Thành phần | Cấu hình |
| --- | --- |
| Server EC2 | `13.213.241.40`, user `ubuntu` |
| Thư mục runtime | `/home/ubuntu/gemini-tools` |
| Compose project | `gemini-tools` |
| Frontend | `127.0.0.1:3020 → app:80` |
| API | `127.0.0.1:3021 → api:5177` |
| Domain mặc định | `tools.ezihubb.com` |
| API trong trình duyệt | `/api` trên cùng domain |
| Images | `ghcr.io/actuallyme98/gemini-tools-api`, `ghcr.io/actuallyme98/gemini-tools-app` |

EziHubb sử dụng 3010–3012 và project Compose riêng. Chứng chỉ Origin hiện có chứa `*.ezihubb.com`. Không dùng tên container cố định hoặc network/volume của EziHubb.

## Pipeline mỗi repo

- Pull request vào `main/develop`, push vào `develop`: lint, test, build, audit dependency production ở mức high, kiểm tra Bash và production container.
- Push `main`: gọi lại CI, sau đó build/push image với tag full commit SHA và `latest`.
- API CI có unit test, test endpoint và test deploy/rollback. Frontend CI có Playwright và kiểm tra Nginx nối lại khi IP container API thay đổi.
- Deploy dùng **image digest** từ job publish. Tag `latest` phục vụ quan sát, không dùng trong release đang deploy.
- Khi `DEPLOY_ENABLED=true`, push `main` tự deploy. Nếu chưa bật, dùng Actions → **Build, publish and deploy** → Run workflow → `deploy=true`.
- Chỉ `main` được publish/deploy. Pipeline dùng environment `production`; nếu environment của repo có required reviewers, GitHub sẽ áp dụng quy tắc đó.

Các action được pin commit SHA giống EziHubb. Node 22 được dùng thống nhất trong CI và Docker. Build không cần AI key hoặc R2 key: test gọi mock, container smoke dùng placeholder trong `.env.example`.

## Chuẩn bị một lần

Các lệnh dưới đây chạy trong **Git Bash**, từ repo API. Script SSH kiểm tra host key bằng `StrictHostKeyChecking=yes`.

```bash
cp scripts/.deploy-config.example scripts/.deploy-config
# Kiểm tra SERVER_IP, SERVER_USER, SSH_KEY, DEPLOY_PATH trong file vừa tạo.
# Chuẩn bị .env API với provider/model và R2 thật.
bash scripts/setup-server.sh
```

Script tạo thư mục runtime, cài engine/Compose, chuyển `.env` qua SSH với quyền 600. Không khởi động container; khi chạy lại, giữ cấu hình runtime đã tồn tại. Đường dẫn SSH key tương đối được tính từ gốc repo. AI/R2 secrets chỉ ở `.env` API trên server.

Nếu máy chưa biết SSH host key, đối chiếu fingerprint qua nguồn tin cậy như console EC2, rồi ghi public host key đã xác minh vào `~/.ssh/known_hosts`. Không dùng `StrictHostKeyChecking=no`.

Server cần Docker Compose hỗ trợ `up --wait`, `curl` và `flock`; server EziHubb đã có các công cụ này.

### Quyền pull GHCR

Workflow publish dùng `GITHUB_TOKEN` với quyền `packages:write`. Server cần quyền đọc cả hai package nếu package private. Đăng nhập một lần bằng classic PAT có `read:packages`:

```bash
# Trên server, token nhập ẩn và chuyển qua stdin.
read -rsp 'GHCR read token: ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u actuallyme98 --password-stdin
unset GHCR_TOKEN
```

Có thể dùng login hiện tại nếu account đó đọc được hai package. Không dùng token trong Dockerfile, build args hoặc URL Git. Tham khảo [GHCR authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

### GitHub secrets và variables cho cả hai repo

Từ repo API, sau khi `gh auth login` và SSH host đã được xác minh:

```bash
bash scripts/configure-github.sh
```

Script lấy key từ `SSH_KEY`, chỉ gửi vào GitHub secret qua stdin, và cấu hình **cả hai repo**:

| Loại | Tên | Giá trị |
| --- | --- | --- |
| Secret | `DEPLOY_SSH_KEY` | Private SSH key cho user deploy |
| Secret | `DEPLOY_KNOWN_HOSTS` | Host key đã xác minh cho server |
| Variable | `DEPLOY_HOST` | `13.213.241.40` |
| Variable | `DEPLOY_USER` | `ubuntu` |
| Variable | `DEPLOY_PATH` | `/home/ubuntu/gemini-tools` |
| Variable | `DEPLOY_ENABLED` | `false` khi thiết lập ban đầu |

Bạn cũng có thể nhập các giá trị này qua Settings → Secrets and variables → Actions. Cần cho runner GitHub kết nối được tới SSH server. Không đưa AI/R2 secrets vào `VITE_*` hoặc frontend. `scripts/.deploy-config`, `.env` và private keys đều được loại khỏi Git/Docker context.

## Release đầu tiên

Commit/push các thay đổi của cả hai repo lên `main` để Actions tạo image. Deploy **API trước**, rồi frontend:

```bash
gh workflow run docker-publish.yml --repo actuallyme98/gemini-tools-api --ref main -f deploy=true
# Đợi deploy API thành công trong Actions, rồi:
gh workflow run docker-publish.yml --repo actuallyme98/gemini-tools-app --ref main -f deploy=true
```

Hoặc deploy thủ công giống script EziHubb, với image full commit SHA đã publish:

```bash
# Từ API repo:
bash scripts/deploy.sh ghcr.io/actuallyme98/gemini-tools-api:FULL_40_CHARACTER_COMMIT_SHA

# Từ frontend repo (copy scripts/.deploy-config.example thành scripts/.deploy-config trước):
bash scripts/deploy.sh ghcr.io/actuallyme98/gemini-tools-app:FULL_40_CHARACTER_COMMIT_SHA
```

Frontend Docker mặc định không đặt `VITE_API_BASE_URL`; Nginx container chuyển `/api` tới API qua Docker network. Resolver tự cập nhật khi API container đổi IP, nên cập nhật API không cần restart frontend.

## Domain và host Nginx

Tạo record Cloudflare `A tools → 13.213.241.40`. Với Cloudflare proxy bật, dùng SSL **Full (strict)** và Origin certificate hiện có.

Script setup đã đặt template tại `/home/ubuntu/gemini-tools/deploy/nginx-gemini-tools.conf`. Kiểm tra domain trong file rồi cài site riêng trên server:

```bash
sudo install -m 644 /home/ubuntu/gemini-tools/deploy/nginx-gemini-tools.conf /etc/nginx/sites-available/gemini-tools
sudo ln -s /etc/nginx/sites-available/gemini-tools /etc/nginx/sites-enabled/gemini-tools
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://tools.ezihubb.com/healthz
curl --fail https://tools.ezihubb.com/api/health
```

Nginx có giới hạn upload 115 MiB và timeout origin 1200 giây. **Cloudflare proxy có giới hạn riêng**: read timeout hiện là 125 giây, và upload Free/Pro tối đa 100 MB. Các batch AI lâu hoặc 11 ảnh lớn có thể vượt giới hạn này dù origin cho phép. Tham khảo [connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) và [upload limits](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/).

Nếu cần request lâu hơn qua cùng domain, dùng DNS only và cài chứng chỉ public như Let's Encrypt, ví dụ `certbot --nginx -d tools.ezihubb.com`, trước khi truy cập trực tiếp. Cloudflare Origin certificate chỉ phù hợp với kết nối qua Cloudflare. Phương án queue/poll cho tác vụ dài là thay đổi chức năng riêng.

Cấu hình R2 CORS cho domain frontend nếu muốn download ảnh/ZIP bằng trình duyệt.

## Deploy, rollback và theo dõi

Engine lấy shared lock bằng `flock` để hai repo không ghi đè trạng thái của nhau. Nó đọc image hiện tại, chỉ thay image của service đang deploy, validate Compose không in secrets, pull image, chờ container healthy và kiểm tra HTTP. API health không gọi AI/R2; frontend health kiểm tra cả trang và proxy API.

Nếu startup/smoke lỗi, engine khôi phục image service trước đó. Với release đầu tiên chưa có image cũ, chỉ gỡ service thất bại. Health check xác nhận ứng dụng khởi động và routing hoạt động, chưa chứng minh tài khoản AI/R2 hoặc model có quyền xử lý ảnh thật.

Trạng thái thành công lưu ở `.images.env`; mỗi service giữ snapshot riêng `.previous.api.env` / `.previous.app.env` cùng Compose snapshot. API và frontend rollback độc lập:

```bash
# Từ repo tương ứng:
bash scripts/deploy.sh --rollback
```

Trên server:

```bash
cd /home/ubuntu/gemini-tools
docker compose --project-name gemini-tools --env-file .images.env -f deploy/compose.production.yml ps
docker compose --project-name gemini-tools --env-file .images.env -f deploy/compose.production.yml logs --tail 100 api app
curl --fail http://127.0.0.1:3021/api/health
curl --fail http://127.0.0.1:3020/api/health
```

Không chạy `docker compose config` không có `--quiet` vì có thể in runtime secrets. Khi đổi `.env`, recreate API bằng cùng image đã publish qua script deploy để kiểm tra lại health. Không rollback nội dung `.env`; snapshot chỉ chứa image/config Compose.

Mỗi service có giới hạn RAM và log rotation. Script không chạy prune toàn server; giữ image cũ để rollback. Release có thời gian gián đoạn ngắn khi Compose recreate service, chưa phải rolling/zero-downtime.

Sau lần deploy đầu thành công, bật auto deploy:

```bash
gh variable set DEPLOY_ENABLED --repo actuallyme98/gemini-tools-api --body true
gh variable set DEPLOY_ENABLED --repo actuallyme98/gemini-tools-app --body true
```

## Kiểm tra local

```bash
# API
npm run lint:check
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
bash test/deployment.test.sh # Linux/WSL; cần flock

# Frontend
npm run lint
npm run build
npm run test:e2e

# Khi có Docker:
docker build -t gemini-tools-api:ci .
bash scripts/container-smoke.sh gemini-tools-api:ci
# Tương tự ở frontend với image gemini-tools-app:ci.
```
