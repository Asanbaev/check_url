#!/usr/bin/env bash
# Копия логики crm_api/scripts/git.sh для репозитория check_url:
# pull --rebase --autostash, commit (без .cursor в индексе), push.
# Корень: CHECK_URL_ROOT или каталог на уровень выше этого скрипта.
# Сообщение: аргументы "$@" или GIT_COMMIT_MESSAGE, иначе read.
set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CHECK_URL_ROOT:-$(cd "$_SCRIPT_DIR/.." && pwd)}"
LABEL="check_url"

cd "$ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
	echo "Ошибка: не git-репозиторий: $ROOT" >&2
	exit 1
fi

git config pull.rebase true

has_upstream=0
stash_count_before_pull=0
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
	has_upstream=1
	stash_count_before_pull="$(git stash list | wc -l | tr -d '[:space:]')"
	echo "Синхронизация ${LABEL} с удалённой веткой (git pull --rebase --autostash)..."
	git pull --rebase --autostash
	stash_count_after_pull="$(git stash list | wc -l | tr -d '[:space:]')"
	if [[ "$stash_count_after_pull" -gt "$stash_count_before_pull" ]]; then
		echo "Ошибка: git pull --rebase --autostash не смог вернуть локальные изменения без stash." >&2
		echo "Разберите stash вручную и повторите команду, иначе в коммит могут попасть временные правки." >&2
		exit 1
	fi
	if [[ -n "$(git diff --name-only --diff-filter=U)" ]]; then
		echo "Ошибка: после git pull остались конфликтные файлы. Сначала разрешите конфликт вручную." >&2
		exit 1
	fi
fi

ahead_count=0
if [[ "$has_upstream" -eq 1 ]]; then
	ahead_count="$(git rev-list --count '@{u}..HEAD')"
fi

if [[ -z "$(git status --porcelain)" ]]; then
	if [[ "$ahead_count" -gt 0 ]]; then
		echo "Новых файлов для коммита нет, но есть локальные коммиты ${LABEL} — выполняю push."
		git push
		exit 0
	fi
	echo "${LABEL}: нет изменений для коммита."
	exit 0
fi

case "$(uname -s)" in
MINGW* | MSYS* | CYGWIN*)
	echo "Нажмите любую клавишу для выхода..."
	read -n 1 -s
	;;
esac

git add -A
if git diff --cached --name-only | grep -q '^\.cursor/'; then
	git restore --staged .cursor 2>/dev/null || true
fi

if [[ -z "$(git diff --cached --name-only)" ]]; then
	echo "${LABEL}: нечего коммитить (нет изменений или только .cursor) — пропуск."
	git reset HEAD >/dev/null 2>&1 || true
	exit 0
fi

if [[ $# -ge 1 ]]; then
	msg="$*"
	if [[ -z "${msg// }" ]]; then
		echo "Пустое сообщение коммита — индекс сброшен." >&2
		git reset HEAD >/dev/null 2>&1 || true
		exit 1
	fi
elif [[ -n "${GIT_COMMIT_MESSAGE:-}" ]] && [[ -n "${GIT_COMMIT_MESSAGE// }" ]]; then
	msg="$GIT_COMMIT_MESSAGE"
else
	read -r -p "Сообщение коммита для ${LABEL}: " msg
	if [[ -z "${msg// }" ]]; then
		echo "Пустое сообщение — индекс сброшен." >&2
		git reset HEAD >/dev/null 2>&1 || true
		exit 1
	fi
fi

git commit -m "$msg"
git push
