HLS Storage and Chunker

Use run.sh script to build and run sample container.

Use config.yaml to configure source feeds and chunk submission endpoint.
By default, config.yaml must be mounted to /config/config.yaml inside
container. Data is store into /data inside container, so for persistance the
container's /data must be mounted to some directory on host system.

To test receiving chunk submissions inside running container,
use submission_test.sh script.
