# Portable Deploy

Files needed on the target machine:

- `job-visualizer-images.tar`
- `docker-compose.yml`
- `.env.example` copied to `.env`

Recommended steps:

1. `docker load -i job-visualizer-images.tar`
2. Copy `.env.example` to `.env`
3. Edit `.env`
   - keep `HOST_BIND_IP=0.0.0.0` for maximum portability
   - set `LOCAL_DOMAIN` to your chosen LAN domain
   - set `APP_HOST_PORT` and `DOMAIN_HTTP_PORT` if needed
4. Run `Start-Portable.bat`
5. On LAN clients, map the chosen domain to the target machine IP via router DNS or hosts file

Example hosts entry:

`192.168.0.150 jobviz.home.arpa`

Useful commands:

- `Start-Portable.bat`: start the full stack
- `Stop-Portable.bat`: stop the full stack
- `powershell -File .\Check-Portable.ps1`: test direct IP access and domain proxy access from the target machine
