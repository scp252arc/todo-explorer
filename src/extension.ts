import * as vscode from 'vscode';

/**
 * Одна задача, обнаруженная в комментарии исходного файла.
 *
 * @remarks
 * Номер строки хранится в формате, привычном пользователю (начиная с 1),
 * тогда как API редактора VS Code использует индексы строк, начиная с 0.
 */
export interface TodoItem {
    /** Тип найденного комментария: `TODO` или `FIXME`. */
    kind: string;

    /** Текст задачи после маркера TODO/FIXME. */
    description: string;

    /** Номер строки в файле, начиная с 1. */
    line: number;

    /** URI исходного файла, необходимый для навигации. */
    file: vscode.Uri;
}

/**
 * Ищет комментарии TODO и FIXME в текстовом документе.
 *
 * Анализирует строки документа с помощью регулярного выражения.
 * Для каждого совпадения создаёт объект {@link TodoItem}.
 *
 * @remarks
 * Поддерживаются типичные маркеры комментариев `//`, `#`, `/*`, `*` и `<!--`.
 * Поиск основан на регулярном выражении, поэтому не выполняет полноценный
 * синтаксический разбор: похожий текст внутри строковых литералов
 * в некоторых случаях тоже может быть принят за комментарий.
 *
 * @param document - Документ VS Code, в котором выполняется поиск.
 * @returns Найденные задачи с типом, описанием, номером строки и URI файла.
 *
 * @example
 * ```ts
 * const document = await vscode.workspace.openTextDocument(uri);
 * const tasks = scanDocument(document);
 * console.log(tasks.length);
 * ```
 */
export function scanDocument(document: vscode.TextDocument): TodoItem[] {
    const results: TodoItem[] = [];

    for (let i = 0; i < document.lineCount; i++) {
        const text = document.lineAt(i).text;

        const match = text.match(
            /(?:\/\/|#|\/\*+|<!--|\*)\s*(TODO|FIXME)\b\s*:?\s*(.*)/i
        );

        if (!match) {
            continue;
        }

        results.push({
            kind: match[1].toUpperCase(),
            description: match[2].replace(/(?:\*\/|-->)\s*$/, '').trim(),
            line: i + 1,
            file: document.uri
        });
    }

    return results;
}

/**
 * Узел дерева, представляющий файл с найденными задачами.
 *
 * @remarks
 * Показывает относительный путь к файлу и количество задач.
 * По умолчанию отображается в раскрытом состоянии.
 */
export class FileNode extends vscode.TreeItem {
    /**
     * Создаёт строку файла в панели TODO Explorer.
     *
     * @param file - URI файла, содержащего задачи.
     * @param tasks - Все найденные задачи этого файла.
     */
    constructor(
        readonly file: vscode.Uri,
        readonly tasks: TodoItem[]
    ) {
        super(
            vscode.workspace.asRelativePath(file),
            vscode.TreeItemCollapsibleState.Expanded
        );

        this.description = `${tasks.length}`;
        this.iconPath = new vscode.ThemeIcon('file-code');
    }
}

/**
 * Узел дерева, представляющий отдельную задачу TODO или FIXME.
 *
 * @remarks
 * Отображает тип задачи, её описание и номер строки.
 * По нажатию запускает команду `todo-explorer.openTask`.
 */
export class TaskNode extends vscode.TreeItem {
    /**
     * Создаёт элемент задачи с иконкой и командой перехода к исходному коду.
     *
     * @param task - Задача, которую нужно отобразить в дереве.
     */
    constructor(readonly task: TodoItem) {
        super(
            `${task.kind}: ${task.description}`,
            vscode.TreeItemCollapsibleState.None
        );

        this.description = `стр. ${task.line}`;

        this.iconPath = new vscode.ThemeIcon(
            task.kind === 'FIXME' ? 'warning' : 'check'
        );

        this.command = {
            command: 'todo-explorer.openTask',
            title: 'Перейти к задаче',
            arguments: [task]
        };
    }
}

/**
 * Служебный узел дерева, показывающий ход сканирования проекта.
 *
 * @remarks
 * Пока сканирование идёт, отображает анимированную иконку без команды.
 * В обычном состоянии может служить командой запуска поиска.
 */
export class ScanNode extends vscode.TreeItem {
    /**
     * Создаёт элемент запуска поиска или индикатор выполняемого сканирования.
     *
     * @param scanning - `true`, когда полное сканирование уже выполняется.
     */
    constructor(scanning: boolean) {
        super(
            scanning ? 'Идёт сканирование...' : 'Сканировать проект',
            vscode.TreeItemCollapsibleState.None
        );

        this.iconPath = new vscode.ThemeIcon(
            scanning ? 'sync~spin' : 'search'
        );

        this.tooltip = scanning
            ? 'Подождите, выполняется поиск задач'
            : 'Найти TODO и FIXME во всех файлах проекта';

        if (!scanning) {
            this.command = {
                command: 'todo-explorer.refresh',
                title: 'Сканировать проект'
            };
        }
    }
}

/**
 * Возможные типы элементов дерева TODO Explorer.
 *
 * Файл содержит задачи, задача открывает исходный код,
 * а служебный узел отображает состояние сканирования.
 */
export type TodoNode = FileNode | TaskNode | ScanNode;

/**
 * Отложенное изменение кеша во время полного сканирования.
 *
 * @remarks
 * Дискриминатор `type` позволяет безопасно различать сохранение документа
 * и удаление ресурса, включая удаление каталога.
 */
export type PendingChange =
    | { type: 'save'; document: vscode.TextDocument }
    | { type: 'delete'; uri: vscode.Uri };

/**
 * Управляет поиском задач и их отображением в боковой панели TODO Explorer.
 *
 * @remarks
 * Реализует `TreeDataProvider` для интеграции с VS Code TreeView.
 * Хранит результаты в `Map`, поддерживает полное сканирование рабочей области
 * и инкрементальное обновление при сохранении или удалении файлов.
 *
 * Во время полного сканирования события изменений откладываются, а затем
 * применяются к новому кешу. Это защищает результаты от потери изменений,
 * пришедших непосредственно во время обхода проекта.
 */
export class TodoProvider implements vscode.TreeDataProvider<TodoNode>, vscode.Disposable {
    /** Корневые узлы, отображаемые в дереве, по одному на файл с задачами. */
    private groups: FileNode[] = [];

    /** Кеш: строковый URI файла → список обнаруженных в нём задач. */
    private cache = new Map<string, TodoItem[]>();

    /** Признак выполняемого полного сканирования проекта. */
    private scanning = false;

    /** Было ли завершено хотя бы одно полное сканирование. */
    private hasScanned = false;

    /**
     * Инициализирует поставщик данных и начальное состояние приветствия.
     */
    constructor() {
        this.updateWelcomeState();
    }

    /** Изменения файлов, накопленные в процессе полного сканирования. */
    private readonly pendingChanges = new Map<string, PendingChange>();

    /** Генератор уведомлений VS Code о необходимости перерисовать дерево. */
    private readonly emitter = new vscode.EventEmitter<void>();

    /**
     * Событие изменения структуры дерева, на которое подписывается VS Code.
     *
     * @remarks
     * Вызывается через `emitter.fire()` после обновления модели данных.
     */
    readonly onDidChangeTreeData = this.emitter.event;

    /**
     * Освобождает ресурсы, созданные поставщиком данных.
     *
     * @remarks
     * Вызывается VS Code при удалении расширения из текущего окружения,
     * поскольку поставщик добавлен в `context.subscriptions`.
     */
    dispose(): void {
        this.emitter.dispose();
    }

    /**
     * Устанавливает контекстное состояние панели для приветственного сообщения.
     *
     * @remarks
     * Использует `setContext` с ключом `todoExplorer.scanState`.
     * Значения `unscanned`, `scanning`, `empty` и `ready` позволяют
     * управлять блоками `viewsWelcome` в `package.json`.
     */
    private updateWelcomeState(): void {
        let state: string;

        if (this.scanning) {
            state = 'scanning';
        } else if (this.groups.length > 0) {
            state = 'ready';
        } else if (this.hasScanned) {
            state = 'empty';
        } else {
            state = 'unscanned';
        }

        void vscode.commands.executeCommand(
            'setContext',
            'todoExplorer.scanState',
            state
        );
    }

    /**
     * Возвращает визуальное представление заданного узла дерева.
     *
     * @param element - Узел, который VS Code собирается отобразить.
     * @returns Экземпляр `TreeItem`, содержащий название, иконку и команду.
     */
    getTreeItem(element: TodoNode): vscode.TreeItem {
        return element;
    }

    /**
     * Возвращает дочерние элементы дерева задач.
     *
     * @param element - Родительский узел; если отсутствует, возвращаются
     * корневые элементы дерева.
     * @returns Массив файлов, задач или индикатора сканирования.
     */
    getChildren(element?: TodoNode): TodoNode[] {
        if (!element) {
            return this.scanning
                ? [new ScanNode(true), ...this.groups]
                : this.groups;
        }

        if (element instanceof FileNode) {
            return element.tasks.map(task => new TaskNode(task));
        }

        return [];
    }

    /**
     * Проверяет, разрешено ли сканировать указанный файл.
     *
     * @param uri - URI проверяемого файла.
     * @returns `true`, если файл принадлежит рабочей области VS Code и не
     * находится в исключённом каталоге.
     *
     * @remarks
     * Размер файла проверяется отдельно, в `refresh()` и `applyChange()`.
     */
    private isEligibleFile(uri: vscode.Uri): boolean {
        if (!vscode.workspace.getWorkspaceFolder(uri)) {
            return false;
        }

        const path = vscode.workspace.asRelativePath(uri);

        return !/(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next)(\/|$)/.test(path);
    }

    /**
     * Применяет сохранение или удаление файла к кешу задач.
     *
     * @param change - Событие сохранения документа или удаления URI.
     *
     * @remarks
     * Для сохранения пересканируется только изменённый документ.
     * Если задач больше нет, соответствующий элемент удаляется из кеша.
     * Для удаления каталога удаляются также все вложенные ключи кеша.
     */
    private applyChange(change: PendingChange): void {
        if (change.type === 'delete') {
            const key = change.uri.toString();
            const prefix = key.endsWith('/') ? key : key + '/';

            for (const cachedKey of this.cache.keys()) {
                if (cachedKey === key || cachedKey.startsWith(prefix)) {
                    this.cache.delete(cachedKey);
                }
            }

            return;
        }

        const document = change.document;
        const key = document.uri.toString();

        if (!this.isEligibleFile(document.uri) ||
            Buffer.byteLength(document.getText(), 'utf8') > 1024 * 1024) {
            this.cache.delete(key);
            return;
        }

        const tasks = scanDocument(document);

        if (tasks.length === 0) {
            this.cache.delete(key);
        } else {
            this.cache.set(key, tasks);
        }
    }

    /**
     * Перестраивает дерево задач из содержимого кеша.
     *
     * @remarks
     * Сортирует файлы по относительному пути, обновляет контекст
     * приветственного сообщения и уведомляет VS Code об изменении дерева.
     */
    private rebuildTree(): void {
        this.groups = [...this.cache.values()]
            .sort((a, b) =>
                vscode.workspace.asRelativePath(a[0].file)
                    .localeCompare(vscode.workspace.asRelativePath(b[0].file))
            )
            .map(tasks => new FileNode(tasks[0].file, tasks));

        this.updateWelcomeState();
        this.emitter.fire();
    }

    /**
     * Инкрементально обновляет задачи после сохранения документа.
     *
     * @param document - Сохранённый текстовый документ VS Code.
     *
     * @remarks
     * При обычной работе пересканируется только переданный документ.
     * Если полное сканирование ещё выполняется, изменение записывается
     * в очередь `pendingChanges` и применяется после его завершения.
     */
    onSaved(document: vscode.TextDocument): void {
        if (!this.isEligibleFile(document.uri)) {
            return;
        }

        const change: PendingChange = {
            type: 'save',
            document
        };

        if (this.scanning) {
            this.pendingChanges.set(document.uri.toString(), change);
            return;
        }

        this.applyChange(change);
        this.rebuildTree();
    }

    /**
     * Удаляет из кеша задачи файлов и каталогов, удалённых через VS Code.
     *
     * @param files - URI удалённых файлов или каталогов.
     *
     * @remarks
     * Во время полного сканирования удаление откладывается.
     * После обычного удаления дерево обновляется один раз, даже если
     * в событии присутствует несколько файлов.
     */
    onDeleted(files: readonly vscode.Uri[]): void {
        for (const uri of files) {
            const change: PendingChange = {
                type: 'delete',
                uri
            };

            if (this.scanning) {
                this.pendingChanges.set(uri.toString(), change);
            } else {
                this.applyChange(change);
            }
        }

        if (!this.scanning) {
            this.rebuildTree();
        }
    }

    /**
     * Полностью сканирует рабочую область VS Code в поисках TODO и FIXME.
     *
     * @returns `Promise`, который завершается после обновления результатов.
     *
     * @remarks
     * Файлы ищутся посредством `workspace.findFiles()`; служебные каталоги
     * исключаются, а ресурсы размером более 1 МиБ пропускаются.
     * Прогресс отображается стандартным уведомлением VS Code.
     *
     * Новые результаты собираются в отдельную `Map` и затем заменяют кеш.
     * Сохранения и удаления, произошедшие во время обхода, применяются
     * после его завершения. Повторный запуск при активном поиске игнорируется.
     */
    async refresh(): Promise<void> {
        if (this.scanning) {
            return;
        }

        if (!vscode.workspace.workspaceFolders?.length) {
            this.cache.clear();
            this.hasScanned = true;
            this.rebuildTree();
            vscode.window.showWarningMessage('Открой папку проекта!');
            return;
        }

        this.scanning = true;
        this.updateWelcomeState();
        this.emitter.fire();

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'TODO Explorer: сканирование проекта',
                    cancellable: false
                },
                async progress => {
                    progress.report({ message: 'Поиск файлов...' });

                    const files = await vscode.workspace.findFiles(
                        '**/*',
                        '**/{node_modules,.git,dist,build,out,coverage,.next}/**'
                    );

                    const nextCache = new Map<string, TodoItem[]>();
                    let scanned = 0;
                    let lastReported = 0;

                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];

                        try {
                            if (this.isEligibleFile(file)) {
                                const stat = await vscode.workspace.fs.stat(file);

                                if (stat.size <= 1024 * 1024) {
                                    const document =
                                        await vscode.workspace.openTextDocument(file);

                                    const tasks = scanDocument(document);
                                    scanned++;

                                    if (tasks.length > 0) {
                                        nextCache.set(file.toString(), tasks);
                                    }
                                }
                            }
                        } catch {
                            // Пропускаем недоступные и бинарные файлы
                        }

                        const processed = i + 1;

                        if (processed % 20 === 0 || processed === files.length) {
                            progress.report({
                                message: `${processed} / ${files.length} файлов`,
                                increment: (processed - lastReported) * 100 / files.length
                            });

                            lastReported = processed;
                        }
                    }

                    this.cache = nextCache;
                    this.hasScanned = true;

                    const count = [...nextCache.values()]
                        .reduce((sum, tasks) => sum + tasks.length, 0);

                    vscode.window.setStatusBarMessage(
                        `TODO Explorer: ${count} задач в ${scanned} файлах`,
                        5000
                    );
                }
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Ошибка сканирования: ${String(error)}`
            );
        } finally {
            this.scanning = false;

            for (const change of this.pendingChanges.values()) {
                this.applyChange(change);
            }

            this.pendingChanges.clear();

            this.rebuildTree();
        }
    }
}

/**
 * Точка входа расширения TODO Explorer.
 *
 * @param context - Контекст расширения, содержащий коллекцию ресурсов,
 * автоматически освобождаемых VS Code при деактивации.
 *
 * @remarks
 * Создаёт `TodoProvider`, подключает дерево `todoExplorer.tasks`,
 * регистрирует команды `todo-explorer.refresh` и `todo-explorer.openTask`,
 * а также подписывается на сохранение и удаление файлов.
 *
 * Команда перехода открывает файл и прокручивает редактор к строке задачи.
 * Автоматическое полное сканирование при активации не запускается:
 * пользователь начинает поиск кнопкой в панели.
 */
export function activate(context: vscode.ExtensionContext) {
    const provider = new TodoProvider();

    context.subscriptions.push(provider);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            provider.onSaved(document);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidDeleteFiles(event => {
            provider.onDeleted(event.files);
        })
    );

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(
            'todoExplorer.tasks',
            provider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'todo-explorer.refresh',
            () => provider.refresh()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'todo-explorer.openTask',
            async (task: TodoItem) => {
                const document =
                    await vscode.workspace.openTextDocument(task.file);

                const editor =
                    await vscode.window.showTextDocument(document);

                const position = new vscode.Position(
                    Math.min(task.line - 1, document.lineCount - 1),
                    0
                );

                editor.selection = new vscode.Selection(
                    position,
                    position
                );

                editor.revealRange(
                    new vscode.Range(position, position),
                    vscode.TextEditorRevealType.InCenter
                );
            }
        )
    );
}

/**
 * Точка деактивации расширения.
 *
 * @remarks
 * Дополнительная очистка здесь не требуется: подписки и поставщик
 * данных зарегистрированы в `context.subscriptions`, поэтому VS Code
 * освобождает их автоматически.
 */
export function deactivate() {}
