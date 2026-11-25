FROM mcr.microsoft.com/playwright/python:v1.56.0-noble
WORKDIR /worker
COPY worker/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY worker/frame_worker ./frame_worker
RUN mkdir -p /state /control && chown -R pwuser:pwuser /state /control
USER pwuser
ENV PYTHONUNBUFFERED=1 ART_STATE_DIR=/state ART_CONTROL_DIR=/control
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s CMD ["python", "-m", "frame_worker", "health"]
ENTRYPOINT ["python", "-m", "frame_worker"]
CMD ["run"]
