import pathlib,subprocess
path=pathlib.Path('/etc/nginx/sites-enabled/biomie.magmoveiscorporativos.com.br')
original=path.read_text()
marker='# BIOMIE V2 API staging'
if marker not in original:
    location='''
    # BIOMIE V2 API staging
    location ^~ /supabase/ {
        access_log off;
        proxy_pass http://127.0.0.1:3140/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
        add_header Cache-Control "no-store" always;
        include /etc/nginx/snippets/biomie-security-headers.conf;
    }
'''
    path.write_text(original.replace('    charset utf-8;','    charset utf-8;\n'+location,1))
    p=subprocess.run(['nginx','-t'],capture_output=True,text=True)
    if p.returncode:
        path.write_text(original)
        raise RuntimeError(p.stderr)
    subprocess.run(['systemctl','reload','nginx'],check=True)
print('New API is routed at /supabase/; current PHP interface remains unchanged.')
