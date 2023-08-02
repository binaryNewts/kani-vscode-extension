// Copyright Kani Contributors
// SPDX-License-Identifier: Apache-2.0 OR MIT
import * as vscode from 'vscode';
import { Uri } from 'vscode';

import { connectToDebugger } from './debugger/debugger';
import GlobalConfig from './globalConfig';
import { getKaniPath, getKaniVersion } from './model/kaniRunner';
import { gatherTestItems } from './test-tree/buildTree';
import {
	KaniData,
	TestCase,
	TestFile,
	findInitialFiles,
	getOrCreateFile,
	getWorkspaceTestPatterns,
	testData,
} from './test-tree/createTests';
import { CodelensProvider } from './ui/CodeLensProvider';
import { callConcretePlayback } from './ui/concrete-playback/concretePlayback';
import { runKaniPlayback } from './ui/concrete-playback/kaniPlayback';
import CoverageConfig from './ui/coverage/config';
import { CoverageRenderer, runCodeCoverageAction } from './ui/coverage/coverageInfo';
import { callViewerReport } from './ui/reportView/callReport';
import { showInformationMessage } from './ui/showMessage';
import { SourceCodeParser } from './ui/sourceCodeParser';
import { startWatchingWorkspace } from './ui/watchWorkspace';
import {
	checkCargoExist,
	getContentFromFilesystem,
	getRootDirURI,
	showErrorWithReportIssueButton,
} from './utils';

// Entry point of the extension
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	if (!checkCargoExist()) {
		showErrorWithReportIssueButton(
			'Could not find Cargo package to run Kani. Please create a Cargo package using `cargo init` or `cargo new` to run the extension',
		);
		return;
	}
	try {
		// GET binary path
		const globalConfig = GlobalConfig.getInstance();
		const kaniBinaryPath = await getKaniPath('cargo-kani');
		globalConfig.setFilePath(kaniBinaryPath);

		vscode.window.showInformationMessage(
			`Kani located at ${kaniBinaryPath} being used for verification`,
		);

		// GET Version number and display to user
		await getKaniVersion(globalConfig.getFilePath());
	} catch (error) {
		showErrorWithReportIssueButton(
			'The Kani executable was not found in PATH. Please install it using the instructions at https://model-checking.github.io/kani/install-guide.html and/or make sure it is in your PATH.',
		);
		return;
	}

	const controller: vscode.TestController = vscode.tests.createTestController(
		'Kani Proofs',
		'Kani Proofs',
	);

	// create a uri for the root folder
	context.subscriptions.push(controller);
	// Store coverage objects in a global cache when highlighting. When de-highlighting, the same objects need to be disposed
	const coverageConfig = new CoverageConfig(context);
	const globalConfig = GlobalConfig.getInstance();
	const crateURI: Uri = getRootDirURI();
	const treeRoot: vscode.TestItem = controller.createTestItem(
		'Kani proofs',
		'Kani Proofs',
		crateURI,
	);

	/**
	 * Run Handler is the controlled callback function that runs whenever a test case is clicked
	 *
	 * @param request - Run Request from VSCode, an event token that is passed upon when a test case is clicked
	 * @param cancellation - Cancellation even token that is passed when the stop button is clicked
	 */
	const runHandler = (
		request: vscode.TestRunRequest,
		cancellation: vscode.CancellationToken,
	): void => {
		const queue: { test: vscode.TestItem; data: TestCase }[] = [];
		const run: vscode.TestRun = controller.createTestRun(request);
		// map of file uris to statements on each line:

		const discoverTests = async (tests: Iterable<vscode.TestItem>): Promise<void> => {
			for (const test of tests) {
				// check if each test is in exclude list
				if (request.exclude?.includes(test)) {
					continue;
				}
				// data is test data
				const data: KaniData | undefined = testData.get(test);
				// console.log("Data for each test is", data);
				// check if this is an object of class testcase (that we wrote)
				if (data instanceof TestCase) {
					run.enqueued(test);
					// This queue takes a tuple of test and it's data
					queue.push({ test, data });
				} else {
					// If it's been parsed by the parser, then it's either a testcase or a test heading
					// if it's not already been processed, then get the children under the heading
					// updatefromdisk gets the children and puts them under the test root
					if (data instanceof TestFile && !data.didResolve) {
						await data.updateFromDisk(controller, test);
					}
					// update the test tree with the new heading items
					await discoverTests(gatherTestItems(test.children));
				}
			}
		};

		const runTestQueue = async (): Promise<void> => {
			for (const { test, data } of queue) {
				run.appendOutput(`Running ${test.id}\r\n`);
				if (cancellation.isCancellationRequested) {
					run.skipped(test);
				} else {
					run.started(test);
					await data.run(test, run);
				}

				run.appendOutput(`Completed ${test.id}\r\n`);
			}

			run.end();
		};

		// Initial test case scan across the crate
		discoverTests(request.include ?? gatherTestItems(controller.items)).then(runTestQueue);
	};

	/**
	 * Refresh Handler is run whenever the refresh button is clicked
	 * Actions -
	 * 1. Get all relevant files
	 * 2. Check if they contain proofs
	 * 3. Update test tree with test cases from relevant files
	 */
	controller.refreshHandler = async (): Promise<void> => {
		await Promise.all(
			getWorkspaceTestPatterns().map(({ pattern }) => findInitialFiles(controller, pattern)),
		);
		for (const document of vscode.workspace.textDocuments) {
			updateNodeForDocument(document);
		}
	};

	// Add run handler to run profile as a test run (vs debug run)
	controller.createRunProfile('Kani Proofs', vscode.TestRunProfileKind.Run, runHandler, true);

	// Add crate watcher to vscode subscriptions
	context.subscriptions.push(...startWatchingWorkspace(controller, treeRoot));

	controller.resolveHandler = async (item): Promise<void> => {
		if (!item) {
			context.subscriptions.push(...startWatchingWorkspace(controller));
			return;
		}
		const data: KaniData | undefined = testData.get(item);
		if (data instanceof TestFile) {
			await data.updateFromDisk(controller, item);
			data.addToCrate(controller, item, treeRoot);
		}
	};

	// Run Kani
	const runKani = vscode.commands.registerCommand('Kani.runKani', async () => {
		showInformationMessage('Kani.runKani');
	});

	// Run Cargo Kani
	const runcargoKani = vscode.commands.registerCommand('Kani.runcargoKani', async () => {
		showInformationMessage('Kani.runcargoKani');
	});

	// Add harness for traits
	const addTraitTest = vscode.commands.registerCommand('Kani.addTraitTest', function() {
		// Get the active text editor
		const editor = vscode.window.activeTextEditor;

		if (editor) {
			const document = editor.document;
			const selection = editor.selection;

			const implLine = document.getText(selection).replace('{', '').trim();
			const regexp = /impl(?:<.*>|) (.*) for (.*)/;
			const match = implLine.match(regexp);
			if (!match) {
				showErrorWithReportIssueButton(
					'Trait implementation not recognized. Make sure to select entire implementation line.'
				);
				return;
			}
			const matchFrom = match[1].match(/From<(.*)>/);
			const matchPartialEq = match[1].match(/PartialEq(<.*>|)/);
			const matchPartialOrd = match[1].match(/PartialOrd(<.*>|)/);

			let funcName: string, vars: string, tests: string;
			funcName = vars = tests = '';
			if (matchFrom) {
				const toType = match[2].replace('<', '::<');
				funcName = `from_${matchFrom[1].replace(/[^a-z0-9]/gi, '').toLowerCase()}_${toType.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
				vars = `\tlet t: ${matchFrom[1]} = kani::any();`
				tests = `\tlet _ = ${toType}::from(t); // From conversion should not crash`;
			} else if (match[1] === 'Eq') {
				funcName = `eq_${match[2].replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
				vars = `\tlet a: ${match[2]} = kani::any();\n\tlet b: ${match[2]} = kani::any();\n\tlet c: ${match[2]} = kani::any();`;
				tests = `\tassert!(a == a); // reflexivity\n\tif a == b { assert!(b == a); } // symmetry\n\tif (a == b) && (b == c) { assert!(a == c); } // transitivity\n\tif a != b { assert!(!(a == b)); } // ne eq consistency\n\tif !(a == b) { assert!(a != b); } // eq ne consistency\n\tassert!((a == b) || (a != b)) // totality`;
			} else if (match[1] === 'Ord') {
				funcName = `ord_${match[2].replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
				vars = `\tlet a: ${match[2]} = kani::any();\n\tlet b: ${match[2]} = kani::any();\n\tlet c: ${match[2]} = kani::any();`;
				tests = `\tassert!(a.partial_cmp(&b) == Some(a.cmp(&b)));\n\tassert!(a.max(b) == core::cmp::max_by(a, b, core::cmp::Ord::cmp));\n\tassert!(a.min(b) == core::cmp::min_by(a, b, core::cmp::Ord::cmp));
\tkani::assume(b < c);\n\tif a > c { assert!(a.clamp(b, c) == c); }\n\tif a < b { assert!(a.clamp(b, c) == b); }\n\tif (b < a) && (a < c) { assert!(a.clamp(b, c) == a); }`;
			} else if (matchPartialEq) {
				if (matchPartialEq[1]) {
					funcName = `partialeq_${matchPartialEq[1].replace(/[^a-z0-9]/gi, '').toLowerCase()}_${match[2].replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
					vars = `\tlet a1: ${match[2]} = kani::any();\n\tlet a2: ${match[2]} = kani::any();\n\tlet a3: ${match[2]} = kani::any();\n\tlet b1: ${matchPartialEq[1]} = kani::any();\n\tlet b2: ${matchPartialEq[1]} = kani::any();`;
					tests = `\tif a1 == a2 { assert!(a2 == a1); } // symmetry\n\tif (a1 == a2) && (a2 == a3) { assert!(a1 == a3); } // transitivity\n\tif a1 != a2 { assert!(!(a1 == a2)); } // ne eq consistency\n\tif !(a1 == a2) { assert!(a1 != a2); } // eq ne consistency
\tif (a1 == b1) && (b1 == a2) { assert!(a1 == a2); } // transitivity and symmetry between types\n\tif (a1 == a2) && (a2 == b1) { assert!(a1 == b1); } // transitivity between types\n\tif (a1 == b1) && (b1 == b2) { assert!(a1 == b2); } // transitivity between types
\tif a1 != b1 { assert!(!(a1 == b1)); } // ne eq consistency between types\n\tif !(a1 == b1) { assert!(a1 != b1); } // eq ne consistency between types`;
				} else {
					funcName = `partialeq_${match[2].replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
					vars = `\tlet a: ${match[2]} = kani::any();\n\tlet b: ${match[2]} = kani::any();\n\tlet c: ${match[2]} = kani::any();`;
					tests = `\tif a == b { assert!(b == a); } // symmetry\n\tif (a == b) && (b == c) { assert!(a == c); } // transitivity\n\tif a != b { assert!(!(a == b)); } // ne eq consistency\n\tif !(a == b) { assert!(a != b); } // eq ne consistency`;
				}
			} else if (matchPartialOrd) {
				if (matchPartialOrd[1]) {
					funcName = `partialord_${matchPartialOrd[1].replace(/[^a-z0-9]/gi, '').toLowerCase()}_${match[2].replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
					vars = `\tlet a1: ${match[2]} = kani::any();\n\tlet a2: ${match[2]} = kani::any();\n\tlet a3: ${match[2]} = kani::any();\n\tlet b1: ${matchPartialOrd[1]} = kani::any();\n\tlet b2: ${matchPartialOrd[1]} = kani::any();`;
					tests = `\tif a1 == b1 { assert!(partial_cmp(a1, b1) == Some(core::cmp::Ordering::Equal)); } // eq consistency\n\tif partial_cmp(a1, b1) == Some(core::cmp::Ordering::Equal) { assert!(a1 == b1); } // eq consistency
\tif a1 < b1 { assert!(partial_cmp(a1, b1) == Some(core::cmp::Ordering::Less)); } // lt consistency\n\tif partial_cmp(a1, b1) == Some(core::cmp::Ordering::Less) { assert!(a1 < b1); } // lt consistency
\tif a1 > b1 { assert!(partial_cmp(a1, b1) == Some(core::cmp::Ordering::Greater)); } // gt consistency\n\tif partial_cmp(a1, b1) == Some(core::cmp::Ordering::Greater) { assert!(a1 > b1); } // gt consistency
\tif a1 <= b1 { assert!(a1 < b1 || a1 == b1); } // le consistency\n\tif (a1 < b1) || (a1 == b1) { assert!(a1 <= b1); } // le consistency
\tif a1 >= b1 { assert!(a1 > b1 || a1 == b1); } // ge consistency\n\tif (a1 > b1) || (a1 == b1) { assert!(a1 >= b1); } // ge consistency
\tif a1 != b1 { assert!(!(a1 == b1)); } // ne eq consistency\n\tif !(a1 == b1) { assert!(a1 != b1); } // eq ne consistency
\tif (a1 == a2) && (a2 == b1) { assert!(a1 == b1); } // transitivity\n\tif (a1 < a2) && (a2 < b1) { assert!(a1 < b1); } // transitivity\n\tif (a1 > a2) && (a2 > b1) { assert!(a1 > b1); } // transitivity
\tif (a1 == a2) && (a2 == a3) { assert!(a1 == a3); } // transitivity\n\tif (a1 < a2) && (a2 < a3) { assert!(a1 < a3); } // transitivity\n\tif (a1 > a2) && (a2 > a3) { assert!(a1 > a3); } // transitivity
\tif (a1 == b1) && (b1 == a2) { assert!(a1 == a2); } // transitivity\n\tif (a1 < b1) && (b1 < a2) { assert!(a1 < a2); } // transitivity\n\tif (a1 > b1) && (b1 > a2) { assert!(a1 > a2); } // transitivity
\tif (a1 == b1) && (b1 == b2) { assert!(a1 == b2); } // transitivity\n\tif (a1 < b1) && (b1 < b2) { assert!(a1 < b2); } // transitivity\n\tif (a1 > b1) && (b1 > b2) { assert!(a1 > b2); } // transitivity
\tif a1 < b1 { assert!(b1 > a1); } // duality\n\tif b1 > a1 { assert!(a1 < b1); } // duality`;
				} else {
					funcName = `partialord_${match[2].replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
					vars = `\tlet a: ${match[2]} = kani::any();\n\tlet b: ${match[2]} = kani::any();\n\tlet c: ${match[2]} = kani::any();`;
					tests = `\tif a == b { assert!(a.partial_cmp(&b) == Some(core::cmp::Ordering::Equal)); } // eq consistency\n\tif a.partial_cmp(&b) == Some(core::cmp::Ordering::Equal) { assert!(a == b); } // eq consistency
\tif a < b { assert!(a.partial_cmp(&b) == Some(core::cmp::Ordering::Less)); } // lt consistency\n\tif a.partial_cmp(&b) == Some(core::cmp::Ordering::Less) { assert!(a < b); } // lt consistency
\tif a > b { assert!(a.partial_cmp(&b) == Some(core::cmp::Ordering::Greater)); } // gt consistency\n\tif a.partial_cmp(&b) == Some(core::cmp::Ordering::Greater) { assert!(a > b); } // gt consistency
\tif a <= b { assert!(a < b || a == b); } // le consistency\n\tif (a < b) || (a == b) { assert!(a <= b); } // le consistency
\tif a >= b { assert!(a > b || a == b); } // ge consistency\n\tif (a > b) || (a == b) { assert!(a >= b); } // ge consistency
\tif a != b { assert!(!(a == b)); } // ne eq consistency\n\tif !(a == b) { assert!(a != b); } // eq ne consistency
\tif (a == b) && (b == c) { assert!(a == c); } // transitivity\n\tif (a < b) && (b < c) { assert!(a < c); } // transitivity\n\tif (a > b) && (b > c) { assert!(a > c); } // transitivity
\tif a < b { assert!(b > a); } // duality\n\tif b > a { assert!(a < b); } // duality`;
				}
			} else {
				showErrorWithReportIssueButton(
					'Harness synthesis only implemented for From, Eq, Ord, PartialEq, PartialOrd.'
				);
				return;
			}
			
			vscode.window.showInformationMessage(
				`You may need to implement Arbitrary (kani::any()). If your implementation requires a polymorphic type, please manually fill this in with a specific type instead.`,
			);
			const body = `${vars}\n${tests}`;
			const kaniTest = `#[kani::proof]\nfn ${funcName}() {\n${body}\n}\n`;
			editor.edit(editBuilder => {
				editBuilder.insert(selection.anchor, kaniTest);
			});
		}
	});

	// Register the run viewer report command
	const runningViewerReport = vscode.commands.registerCommand(
		'Kani.runViewerReport',
		async (harnessArgs) => {
			callViewerReport('Kani.runViewerReport', harnessArgs);
		},
	);

	// Register the run viewer report command
	const runningConcretePlayback = vscode.commands.registerCommand(
		'Kani.runConcretePlayback',
		async (harnessArgs) => {
			callConcretePlayback(harnessArgs);
		},
	);

	// Callback function to Find or create files, update test tree and present to user upon trigger
	async function updateNodeForDocument(e: vscode.TextDocument): Promise<void> {
		if (e.uri.scheme !== 'file') {
			return;
		}

		if (!e.uri.path.endsWith('.rs')) {
			return;
		}

		if (!SourceCodeParser.checkFileForProofs(await getContentFromFilesystem(e.uri))) {
			return;
		}

		const { file, data } = await getOrCreateFile(controller, e.uri);
		await data.updateFromContents(controller, e.getText(), file);
		data.addToCrate(controller, file, treeRoot);
	}

	const codelensProvider = new CodelensProvider();
	const rustLanguageSelector = { scheme: 'file', language: 'rust' };

	const providerDisposable = vscode.languages.registerCodeLensProvider(
		rustLanguageSelector,
		codelensProvider,
	);

	// Allows VSCode to enable code lens globally.
	// If the user switches off code lens in settings, the Kani code lens action will be switched off too.
	vscode.commands.registerCommand('codelens-kani.enableCodeLens', () => {
		vscode.workspace.getConfiguration('codelens-kani').update('enableCodeLens', true, true);
	});

	// Allows VSCode to disable code lens globally
	vscode.commands.registerCommand('codelens-kani.disableCodeLens', () => {
		vscode.workspace.getConfiguration('codelens-kani').update('enableCodeLens', false, true);
	});

	// Allows VSCode to enable highlighting globally
	vscode.commands.registerCommand('codelens-kani.enableCoverage', () => {
		vscode.workspace.getConfiguration('codelens-kani').update('highlightCoverage', true, true);
	});

	// Allows VSCode to disable highlighting globally
	vscode.commands.registerCommand('codelens-kani.disableCoverage', () => {
		vscode.workspace.getConfiguration('codelens-kani').update('highlightCoverage', false, true);
	});

	// Register the command for the code lens Kani test runner function
	vscode.commands.registerCommand('codelens-kani.codelensAction', (args: any) => {
		runKaniPlayback(args);
	});

	// Separate rendering logic and re-use everywhere to highlight and de-highlight
	const renderer = new CoverageRenderer(coverageConfig);

	// Register a command to de-highlight the coverage in the active editor
	const dehighlightCoverageCommand = vscode.commands.registerCommand(
		'codelens-kani.dehighlightCoverage',
		() => {
			globalConfig.setCoverage(new Map());
			renderer.renderInterface(vscode.window.visibleTextEditors, new Map());
		},
	);

	// Update the test tree with proofs whenever a test case is opened
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
		vscode.workspace.onDidSaveTextDocument(async (e) => await updateNodeForDocument(e)),
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			// VS Code resets highlighting whenever a document is changed or switched.
			// In order to work around this issue, the highlighting needs to be rendered each time.
			// To keep the rendering time short, we store the coverage metadata as a global cache.
			const cache = globalConfig.getCoverage();
			renderer.renderInterfaceForFile(editor!, cache);
		}),
	);

	context.subscriptions.push(runKani);
	context.subscriptions.push(runcargoKani);
	context.subscriptions.push(addTraitTest);
	context.subscriptions.push(runningViewerReport);
	context.subscriptions.push(runningConcretePlayback);
	context.subscriptions.push(providerDisposable);
	context.subscriptions.push(
		vscode.commands.registerCommand('extension.connectToDebugger', (programName) =>
			connectToDebugger(programName),
		),
	);
	// Register the command for running the coverage action on a harness
	context.subscriptions.push(
		vscode.commands.registerCommand('codelens-kani.highlightCoverage', (args: any) => {
			runCodeCoverageAction(renderer, args);
		}),
	);

	// Register the command for de-highlighting kani's coverage action on a harness
	context.subscriptions.push(dehighlightCoverageCommand);
}
