# The upstream base contains runtimes/tools, not the Stirling application.
FROM stirlingtools/stirling-pdf-base:1.1.1@sha256:6b57e965506d61170851d6e85e4ff1a29fbc66db4fc4bf3d78c0e31fd1fb32ae

LABEL org.opencontainers.image.title="Hulinger Stirling core conversion engine" \
      org.opencontainers.image.version="3.3.0" \
      org.opencontainers.image.source="https://github.com/HuLinger/hulinger-Information-Gathering-Station" \
      org.opencontainers.image.description="MIT core API-only Stirling-PDF with isolated local LibreOffice"

USER root
WORKDIR /opt/stirling

# API-only core release; do not substitute the with-login or full app artifacts.
ADD --checksum=sha256:5cb59682f93bd7d48312d36a87585ef2e8ca9ddfa64bc210dea6bd882925557c \
    https://github.com/Stirling-Tools/Stirling-PDF/releases/download/v3.3.0/Stirling-PDF-server.jar \
    /opt/stirling/server.jar
COPY verify-jar.py /opt/stirling/verify-jar.py
COPY LICENSE.stirling /opt/stirling/LICENSE.stirling
COPY entrypoint.sh /usr/local/bin/stirling-core-entrypoint

RUN python3 /opt/stirling/verify-jar.py /opt/stirling/server.jar \
    && bash -n /usr/local/bin/stirling-core-entrypoint \
    && chmod 0555 /usr/local/bin/stirling-core-entrypoint \
    && chmod 0444 /opt/stirling/server.jar /opt/stirling/LICENSE.stirling \
    && mkdir -p /work/configs /work/logs /work/customFiles /work/clientWebUI \
         /work/pipeline/watchedFolders /work/pipeline/finishedFolders \
         /tmp/stirling-pdf \
    && chown -R 1000:1000 /work /tmp/stirling-pdf

# No external identity, account linking, document storage or UI is needed.
ENV STIRLING_BASE_PATH=/work \
    HOME=/home/stirlingpdfuser \
    TMPDIR=/tmp/stirling-pdf \
    SAL_TMP=/tmp/stirling-pdf \
    SAL_USE_VCLPLUGIN=svp \
    SAL_DISABLE_PRINTERLIST=1 \
    OOO_FORCE_DESKTOP=none \
    XDG_RUNTIME_DIR=/tmp/stirling-pdf/xdg \
    XDG_CACHE_HOME=/tmp/stirling-pdf/cache \
    XDG_CONFIG_HOME=/tmp/stirling-pdf/config \
    DBUS_SESSION_BUS_ADDRESS=/dev/null \
    STIRLING_LO_SANDBOX=enforce \
    STIRLING_LO_ALLOW_RW=/dev:/tmp/stirling-pdf \
    STIRLING_LO_ALLOW_SOCK=/tmp \
    SECURITY_ENABLELOGIN=false \
    SYSTEM_ENABLEANALYTICS=false \
    SYSTEM_ENABLEPOSTHOG=false \
    SYSTEM_ENABLESCARF=false \
    SYSTEM_SHOWUPDATE=false \
    SYSTEM_STIRLINGOFFICECONVERSION=false \
    SYSTEM_ENABLEURLTOPDF=false \
    SYSTEM_ENABLEMOBILESCANNER=false \
    SYSTEM_ENABLEMOBILESIGNATURE=false \
    SYSTEM_SERVERCERTIFICATE_ENABLED=false \
    STORAGE_ENABLED=false \
    PROCESSEXECUTOR_SESSIONLIMIT_LIBREOFFICESESSIONLIMIT=1 \
    SPRING_SERVLET_MULTIPART_MAX_FILE_SIZE=100MB \
    SPRING_SERVLET_MULTIPART_MAX_REQUEST_SIZE=110MB \
    UNO_CONVERSION_TIMEOUT_SECONDS=120 \
    ORT_DISABLE_TELEMETRY=1

USER 1000:1000
WORKDIR /work
EXPOSE 8080
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD curl --fail --silent --max-time 4 http://127.0.0.1:8080/api/v1/info/status >/dev/null \
        && timeout 4 /opt/venv/bin/unoping --host 127.0.0.1 --port 2003 --quiet >/dev/null 2>&1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/stirling-core-entrypoint"]
CMD ["java", "-XX:MaxRAMPercentage=65", "-XX:+ExitOnOutOfMemoryError", "-Djava.awt.headless=true", "-Djava.io.tmpdir=/tmp/stirling-pdf", "-jar", "/opt/stirling/server.jar", "--server.port=8080"]
