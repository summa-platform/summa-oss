#!/bin/bash

scriptdir="$(cd "`dirname "$0"`"; pwd)"

cd "$scriptdir"

registry_datadir="$HOME/registryStorage"

usage() {
	echo "usage: $0 [ENV] [deploy] [--clean] STACK"
	echo "       $0 [ENV] full"
	echo "       $0 [ENV] build [list of services]"
	echo "       $0 [ENV] push [list of services]"
	echo "       $0 [ENV] pull [list of services]"
	echo "       $0 [ENV] prep [list of services]"
	echo "       $0 [ENV] redeploy [--config] [--stack STACK] [list of services]"
	echo "       $0 [ENV] config [--stack STACK] configname1=sourcefile1 [configname2=sourcefile2] ..."
	echo "       $0 [ENV] remove|rm STACK"
	echo "       $0 [ENV] registry [run|start] [DATADIR]"
	echo "       $0 [ENV] registry remove|rm|stop"
	echo "       $0 [ENV] registry garbage-collect|gc|gb"
	echo "       $0 [ENV] registry list|ls [REPOSITORY]"
	echo "       $0 [ENV] registry remove|rm REPOSITORY TAG1 [TAG2] [TAG3] ..."
	echo "       $0 [ENV] local [up|down|...other docker-compose arguments...]"
	echo "       $0 [ENV] env"
	echo "       $0 [ENV] clean"
	echo
	echo
	echo "Optional first argument ENV specifies the environment to be used, valid ENV values are:"
	echo "* prod or --prod, only production environment (.env) will be used, additionally invokes 'prod-latest' (below) for build, push and prep commands"
	echo "* prod-latest or --prod-latest, only production environment (.env) and 'latest' image tags environemnt (.latest.env) will be used"
	echo "* prod-no-latest or --prod-no-latest, same as 'prod', but no 'prod-latest' will be invoked for any commands"
	echo "* dev or --dev, development environment (.dev.env) will be applied over production environment"
	echo "development is the default environment and hence can be omitted"
	echo
	echo
	echo "registry: run local insecure registry, default DATADIR is $registry_datadir"
	echo
	echo "build: build images"
	echo
	echo "push: push to [local] registry"
	echo
	echo "prep: prepare images by building and pulling"
	echo
	echo "local: run docker-compose locally, extra arguments are passed directly to docker-compose"
	echo
	echo "deploy (keyword is optional): deploy/update (only labels) stack, use --clean to remove old stack"
	echo
	echo "full: full (re)deployment of stack, includes building and pushing of new images, and removing old stack"
	echo
	echo "redeploy: re-deploys only specified services by forcing re-pull of images, optionally reload configuration from files"
	echo
	echo "config: update specified configs"
	echo
	echo "env: output combined env for debugging"
	echo
	echo "clean: remove temporary files that may be left after failed deploy attempts"
	echo
	echo "Override docker-compose configuration in docker-compose.override.yml"
	echo "Override production env configuration (.env) with .local.env or local.env"
	echo "Override development env configuration (.dev.env) with .dev.local.env, dev.local.env, .local.dev.env or local.dev.env"
	echo
	echo
	echo "NOTE: running build, push and prep commands with production environment"
	echo "      will additionally run build, push and prep with 'latest' tags environment if 'prod' or 'dev' is used"
	echo
}

([ "$1" = "help" ] || [ -z "$1" ]) && usage && exit 0
for arg in "$@"; do
	([ "$arg" = "-h" ] || [ "$arg" = "--help" ]) && usage && exit 0
done

prod=0
latest=0
nolatest=0
([ "$1" == "prod" ] || [ "$1" == "--prod" ]) && prod=1 && latest=0 && shift
([ "$1" == "dev" ] || [ "$1" == "--dev" ]) && prod=0 && latest=1 && shift
([ "$1" == "prod-latest" ] || [ "$1" == "--prod-latest" ]) && prod=1 && latest=1 && shift
([ "$1" == "prod-no-latest" ] || [ "$1" == "--prod-no-latest" ]) && prod=1 && latest=0 && nolatest=1 && shift

# import envs
set -a
# source prod env
for n in env; do
	for f in .$n $n .$n.sh $n.sh; do
		[ -f $f ] && echo "Sourcing $f" && . ./$f
	done
done
# source latest env
if [ $latest -eq 1 ]; then
	for n in latest.env; do
		for f in .$n $n .$n.sh $n.sh; do
			[ -f $f ] && echo "Sourcing $f" && . ./$f
		done
	done
fi
# source local prod env
for n in local.env env.local; do
	for f in .$n $n .$n.sh $n.sh; do
		[ -f $f ] && echo "Sourcing $f" && . ./$f
	done
done
# source dev env
if [ $prod -eq 0 ]; then
	for n in dev.env env.dev; do
		for f in .$n $n .$n.sh $n.sh; do
			[ -f $f ] && echo "Sourcing $f" && . ./$f
		done
	done
fi
# source local dev env
if [ $prod -eq 0 ]; then
	for n in dev.local.env local.dev.env dev.env.local local.env.dev; do
		for f in .$n $n .$n.sh $n.sh; do
			[ -f $f ] && echo "Sourcing $f" && . ./$f
		done
	done
fi
set +a


build() {
	docker-compose build --pull "$@"
}

push() {
	docker-compose push "$@"
}

pull() {
	docker-compose pull "$@"
}

remove() {
	wait=0
	while [ $# -gt 0 ]; do
		[ "$1" = "--wait" ] && wait=1
		[[ "$1" != -* ]] && stack="$1"
		shift
	done
	[ -z "$stack" ] && echo "error: stack name not specified" && return 1

	if [ -n "`docker stack ls | grep "$stack"`" ]; then

		echo "Removing stack $stack"
		docker stack rm "$stack"

		if [ $wait -eq 1 ]; then
			echo "Waiting for stack $stack to be removed"
			local left=60	# max 60s wait
			# https://github.com/moby/moby/issues/29293#issuecomment-318852549
			until ([ -z "$(docker service ls --filter label=com.docker.stack.namespace=$stack -q)" ] \
				&& [ -z "$(docker network ls --filter label=com.docker.stack.namespace=$stack -q)" ]) \
				|| [ "$left" -le 0 ]; do
				sleep 1;
				left=$(($left-1))
			done
			if [ -n "$(docker service ls --filter label=com.docker.stack.namespace=$stack -q)" ] \
				|| [ -n "$(docker network ls --filter label=com.docker.stack.namespace=$stack -q)" ]; then
				echo "Warning: timed out, but stack is not yet removed completely"
			fi
		fi
    fi
}

run_local_registry() {
	[ -n "$1" ] && registry_datadir="$1"
	echo "registry data directory: $registry_datadir"
	[ ! -d "$registry_datadir" ] && mkdir -p "$registry_datadir"
	local config=
	[ -f "./config/registry-config.yml" ] && config=(--mount "type=bind,src=$PWD/config/registry-config.yml,dst=/etc/docker/registry/config.yml")
	docker service create \
	  --name registry \
	  --constraint 'node.role == manager' \
	  --mount type=bind,src=$registry_datadir,dst=/var/lib/registry "${config[@]}" \
	  -p 5000:5000 \
	  --replicas 1 \
	  registry:2
	# --constraint 'node.labels.registry == true'
}

remove_local_registry() {
	if [ -n "`docker service ls | grep registry`" ]; then
		echo "Removing registry service ..."
		docker service rm registry
	fi
}

garbage_collect_local_registry() {
	if [ -n "`docker service ls | grep registry`" ]; then
		docker exec -ti registry.1.$(docker service ps -f 'name=registry.1' registry -q --no-trunc | head -n1) bin/registry garbage-collect /etc/docker/registry/config.yml
	fi
}

deploy_stack() {
	config="$1"
	stack="$2"
	echo "Deploying stack $stack"
	docker stack deploy --compose-file "$config" --prune --with-registry-auth "$stack"
}

deploy() {
	remove_old_stack=0
	no_clean=0
	while [ $# -gt 0 ]; do
		([ "$1" = "--clean" ] || [ "$1" = "--remove" ] || [ "$1" = "--rm" ]) && remove_old_stack=1
		[ "$1" = "--no-clean" ] && no_clean=1
		[[ "$1" != -* ]] && stack="$1"
		shift
	done
	[ -z "$stack" ] && >&2 echo "error: stack name not specified" && return 1

	if ([ $remove_old_stack -eq 1 ] && [ -n "`docker stack ls | grep "$stack"`" ]); then
		echo "Waiting for old stack to be removed ..."
		remove --wait "$stack"
	fi

	if [ $no_clean -eq 0 ] && [ -n "`ls -1 docker-compose.combined.*.yml 2> /dev/null`" ]; then
		echo "Cleaning up temporary files from previous deployment"
		rm docker-compose.combined.*.yml 2> /dev/null
	fi

	if [ -f docker-compose.override.yml ]; then

		tmp="`mktemp docker-compose.combined.XXXX.yml`"

		echo "Write composite configuration to $tmp"

		docker-compose -f docker-compose.yml -f docker-compose.override.yml config > "$tmp"

		deploy_stack "$tmp" "$stack"

		[ $? -ne 0 ] && >&2 echo "Error deploying stack, verify configuration in $tmp" && exit 1

		if [ $no_clean -eq 0 ]; then
			echo "Removing $tmp"
			rm "$tmp"
		fi
	else

		deploy_stack "docker-compose.yml" "$stack"

	fi

	# env $(cat .env | grep ^[A-Z] | xargs) docker stack deploy --compose-file docker-compose.yml --prune --with-registry-auth $@
}

deploy_local() {
	local args=()
	for f in "docker-compose.override.yml"; do
		[ ! -f "$f" ] && continue;
		args+=(-f "$f")
	done
	docker-compose -f docker-compose.yml -f docker-compose.local.yml "${args[@]}" "$@"
}

retag() {
	local args=()
	for f in "docker-compose.override.yml"; do
		[ ! -f "$f" ] && continue;
		args+=(-f "$f")
	done
	docker-compose -f docker-compose.yml "${args[@]}" config 2> /dev/null | ./retag.py "$@"
}

prune() {
	local args=()
	for f in "docker-compose.override.yml"; do
		[ ! -f "$f" ] && continue;
		args+=(-f "$f")
	done
	docker-compose -f docker-compose.yml "${args[@]}" config 2> /dev/null | ./prune.py "$@"
}

service_update_config() {
	dry_run=0
	confdefs=()
	while [ $# -gt 0 ]; do
		[[ "$1" != --* ]] && confdefs+=("$1")
		([ "$1" = "--dry" ] || [ "$1" == "--dry-run" ]) && dry_run=1
		if [ "$1" = "--stack" ]; then
			shift
			stack="${1}_"
		fi
		shift
	done

	if [ -n "$stack" ]; then
		services=()
		for service in `docker service ls --format {{.Name}}`; do
			[ "${service##$stack}" = "$service" ] && continue
			services+=("$service")
		done
	else
		services=(`docker service ls --format {{.Name}}`)
	fi

	[ $dry_run -eq 1 ] && echo "Dry-run: no changes will be made"
	# echo "Services: ${services[@]}"
	# echo "Configurations: ${confdefs[@]}"

	for confdef in "${confdefs[@]}"; do
		IFS='='; confdef=($confdef); unset IFS
		config="${confdef[0]}"
		config_source="${confdef[1]}"
		config="$stack$config"
		[ -z "$config_source" ] && >&2 echo "error: source file for configuration $config not specified" && exit 1
		[ ! -f "$config_source" ] && >&2 echo "error: source file for configuration $config is invalid: $config_source" && exit 1
		echo "Updating config $config from file $config_source"
		config_services=()
		for service in "${services[@]}"; do
			# echo "Service: $service"
			for cfg in `docker service inspect $service \
				--format '{{range .Spec.TaskTemplate.ContainerSpec.Configs}}{{.ConfigName}}:{{.File.Name}}{{end}}'`; do
				IFS=':'; cfg=($cfg); unset IFS
				config_name="${cfg[0]}"
				config_file="${cfg[1]}"
				[ "$config_name" != "$config" ] && continue
				config_services+=("$service:$config_file")
			done
		done
		for config_service in "${config_services[@]}"; do
			IFS=':'; config_service=($config_service); unset IFS
			service="${config_service[0]}"
			config_file="${config_service[1]}"
			echo "Removing config $config from service $service"
			[ $dry_run -eq 0 ] && docker service update --detach=false --config-rm $config $service && echo
		done
		# remove old config
		if [ -n "`docker config ls --format {{.Name}} | grep "$config"`" ]; then
			echo "Removing old config $config"
			[ $dry_run -eq 0 ] && docker config rm $config && echo
		fi
		# create new config from source
		echo "Creating config $config from file $config_source"
		[ $dry_run -eq 0 ] && docker config create $config $config_source && echo
		# add config to services
		for config_service in "${config_services[@]}"; do
			IFS=':'; config_service=($config_service); unset IFS
			service="${config_service[0]}"
			config_file="${config_service[1]}"
			echo "Adding new config $config to service $service"
			[ $dry_run -eq 0 ] && docker service update --detach=false --config-add source=$config,target=$config_file $service && echo
		done
	done

	# docker service ls --format {{.Name}}
	# docker service inspect summa-test_entrypoint --format '{{range .Spec.TaskTemplate.ContainerSpec.Configs}}{{.ConfigName}}:{{.File.Name}}{{end}}'
	# docker service update summa-test_entrypoint --config-rm summa-test_entrypoint_nginx_config summa-test_entrypoint
	# docker config rm summa-test_entrypoint_nginx_config
	# docker config create summa-test_entrypoint_nginx_config -
	# docker service update summa-test_entrypoint --config-add source=summa-test_entrypoint_nginx_config,target=/etc/nginx/conf.d/default.conf --detach=false
}

if [ "$1" = "build" ]; then

	shift
    build "$@"

	[ $prod -eq 1 ] && [ $latest -ne 1 ] && [ $nolatest -ne 1 ] && "$0" prod-latest build "$@"

elif [ "$1" = "env" ]; then

	shift
	env

elif [ "$1" = "push" ]; then

	shift
	push "$@"

	[ $prod -eq 1 ] && [ $latest -ne 1 ] && [ $nolatest -ne 1 ] && "$0" prod-latest push "$@"

elif [ "$1" = "pull" ]; then

	shift
	pull "$@"

elif [ "$1" = "prep" ] || [ "$1" = "prepare" ]; then

	shift
    build "$@" && push "$@"

	[ $prod -eq 1 ] && [ $latest -ne 1 ] && [ $nolatest -ne 1 ] && "$0" prod-latest prep "$@"

elif [ "$1" = "local" ]; then

	shift
	deploy_local "$@"

elif [ "$1" = "rm" ] || [ "$1" = "remove" ]; then

	shift
    remove "$@"

elif [ "$1" = "config" ]; then

	shift
	service_update_config "$@"

elif [ "$1" = "full" ]; then

	shift

    stack="$1"
    shift

    build "$@"
    push "$@"

	# [ $prod -eq 1 ] && [ $latest -ne 1 ] && [ $nolatest -ne 1 ] && "$0" prod-latest prep "$@"

    deploy --clean "$stack"

elif [ "$1" = "registry" ]; then

	shift
	if [ "$1" = "list" ] || [ "$1" = "ls" ]; then
		shift
		echo "---"
		./registry-delete.sh "$1"
	elif [ $# -ge 3 ] && ([ "$1" = "remove" ] || [ "$1" = "rm" ]); then
		shift
		echo "---"
		./registry-delete.sh "$@"
	elif [ "$1" = "remove" ] || [ "$1" = "rm" ] || [ "$1" = "stop" ]; then
		shift
		[ $# -eq 1 ] && >&2 echo "error: missing tag arguments" && exit 1
		remove_local_registry
	elif [ "$1" = "garbage-collect" ] || [ "$1" = "gc" ] || [ "$1" = "gb" ]; then
		shift
		garbage_collect_local_registry
	else
		([ "$1" = "run" ] || [ "$1" = "start" ]) && shift
		run_local_registry "$@"
	fi

elif [ "$1" = "clean" ]; then

	echo "Cleaning up..."
	rm docker-compose.combined.*.yml

elif [ "$1" = "redeploy" ]; then

    shift
	reload_config=0
	[ "$1" = "--config" ] && reload_config=1 && shift
	if [ "$1" = "--stack" ]; then
		shift
		stack="${1}_"
		shift
	fi
	[ "$1" = "--config" ] && reload_config=1 && shift

	if [ $reload_config -eq 1 ]; then
		configs=()
		for service in "$@"; do
			configs=("${configs[@]}" `docker service inspect $stack$service \
				--format '{{range .Spec.TaskTemplate.ContainerSpec.Configs}}{{.ConfigName}}:{{.File.Name}}{{end}}' | sed -e 's/:.*$//'`)
		done
		configs=(`printf '%s\n' "${configs[@]}" | sort | uniq`)

		if [ -n "${configs[@]}" ]; then
			tmp="`mktemp docker-compose.combined.XXXX.yml`"
			echo $tmp
			docker-compose -f docker-compose.yml -f docker-compose.override.yml config > "$tmp"

			args=()
			# [ -n "$stack" ] && args=("${args[@]}" --stack "$stack")

			for config in "${configs[@]}"; do
				config_stack="`docker config inspect test_db_config  --format '{{index .Spec.Labels "com.docker.stack.namespace"}}'`"
				# macOS compatible sed
				config="${config##${config_stack}_}"
				config_file="`cat "$tmp" | sed -e '1p' | sed -e '1,/^configs:/d ; /^[^ ]/,$d' | sed -e '1p' | sed -e "1,/$config:/d ; /^ *file:/"'!d' | sed -e 's/^ *file: *// ; 2,$d'`"
				# config_file="`sed -e '0,/^configs:\s*$/d' -e '/^\S/,$d' "$tmp" | grep -A 1 " $config:" | tail -n 1 | sed -e 's/^ *file: //'`"
				args=("${args[@]}" "${config}=$config_file")
			done

			[ -n "$tmp" ] && rm "$tmp"

			echo

			service_update_config "${args[@]}"
		fi

	fi

    for service in "$@"; do
        echo "Redeploying $stack$service ..."
		image="`docker service ps $stack$service --format {{.Image}} --filter desired-state=running | head -n 1`"
		[ -z "$image" ] && image="`docker service ps $stack$service --format {{.Image}} | head -n 1`"
		[ -z "$image" ] && echo "service $stack$service not found, skipping" && continue
		docker service update $stack$service --detach=false --force --image $image
    done

elif [ "$1" = "retag" ]; then

	shift
	retag "$@"

elif [ "$1" = "prune" ]; then

	shift
	prune "$@"

# elif [ "$1" = "deploy" ]; then
else

	[ "$1" = "deploy" ] && shift
    deploy "$@"

# else
# 	>&2 echo "error: unknown command $1"
# 	usage
# 	exit 1
fi
