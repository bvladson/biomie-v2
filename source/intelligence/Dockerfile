# BIOMIE Intelligence Engine: contêiner avulso (sem porta, sem acesso ao Omie), construído a partir
# da raiz da release: docker build -f intelligence/Dockerfile <release>
FROM python:3.12.7-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY intelligence/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY intelligence/biomie_intel ./biomie_intel
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.revision=$GIT_COMMIT
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin intel
USER intel
ENTRYPOINT ["python", "-m", "biomie_intel"]
CMD ["run", "--trigger", "schedule"]
