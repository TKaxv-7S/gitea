import $ from 'jquery';
import {htmlEscape} from 'escape-goat';
import {createCodeEditor} from './codeeditor.ts';
import {hideElem, queryElems, showElem, createElementFromHTML} from '../utils/dom.ts';
import {initMarkupContent} from '../markup/content.ts';
import {attachRefIssueContextPopup} from './contextpopup.ts';
import {POST} from '../modules/fetch.ts';
import {initDropzone} from './dropzone.ts';

function initEditPreviewTab($form) {
  const $tabMenu = $form.find('.repo-editor-menu');
  $tabMenu.find('.item').tab();
  const $previewTab = $tabMenu.find('a[data-tab="preview"]');
  if ($previewTab.length) {
    $previewTab.on('click', async function () {
      const $this = $(this);
      let context = `${$this.data('context')}/`;
      const mode = $this.data('markup-mode') || 'comment';
      const $treePathEl = $form.find('input#tree_path');
      if ($treePathEl.length > 0) {
        context += $treePathEl.val();
      }
      context = context.substring(0, context.lastIndexOf('/'));

      const formData = new FormData();
      formData.append('mode', mode);
      formData.append('context', context);
      formData.append('text', $form.find('.tab[data-tab="write"] textarea').val());
      formData.append('file_path', $treePathEl.val());
      try {
        const response = await POST($this.data('url'), {data: formData});
        const data = await response.text();
        const $previewPanel = $form.find('.tab[data-tab="preview"]');
        if ($previewPanel.length) {
          renderPreviewPanelContent($previewPanel, data);
        }
      } catch (error) {
        console.error('Error:', error);
      }
    });
  }
}

export function initRepoEditor() {
  const dropzoneUpload = document.querySelector('.page-content.repository.editor.upload .dropzone');
  if (dropzoneUpload) initDropzone(dropzoneUpload);

  const editArea = document.querySelector<HTMLTextAreaElement>('.page-content.repository.editor textarea#edit_area');
  if (!editArea) return;

  for (const el of queryElems<HTMLInputElement>(document, '.js-quick-pull-choice-option')) {
    el.addEventListener('input', () => {
      if (el.value === 'commit-to-new-branch') {
        showElem('.quick-pull-branch-name');
        document.querySelector<HTMLInputElement>('.quick-pull-branch-name input').required = true;
      } else {
        hideElem('.quick-pull-branch-name');
        document.querySelector<HTMLInputElement>('.quick-pull-branch-name input').required = false;
      }
      document.querySelector('#commit-button').textContent = el.getAttribute('data-button-text');
    });
  }

  const filenameInput = document.querySelector<HTMLInputElement>('#file-name');
  function joinTreePath() {
    const parts = [];
    for (const el of document.querySelectorAll('.breadcrumb span.section')) {
      const link = el.querySelector('a');
      parts.push(link ? link.textContent : el.textContent);
    }
    if (filenameInput.value) {
      parts.push(filenameInput.value);
    }
    document.querySelector<HTMLInputElement>('#tree_path').value = parts.join('/');
  }
  filenameInput.addEventListener('input', function () {
    const parts = filenameInput.value.split('/');
    const links = Array.from(document.querySelectorAll('.breadcrumb span.section'));
    const dividers = Array.from(document.querySelectorAll('.breadcrumb .breadcrumb-divider'));
    let warningDiv = document.querySelector<HTMLDivElement>('.ui.warning.message.flash-message.flash-warning.space-related');
    let containSpace = false;
    if (parts.length > 1) {
      for (let i = 0; i < parts.length; ++i) {
        const value = parts[i];
        const trimValue = value.trim();
        if (trimValue === '..') {
          // remove previous tree path
          if (links.length > 0) {
            const link = links.pop();
            const divider = dividers.pop();
            link.remove();
            divider.remove();
          }
          continue;
        }
        if (i < parts.length - 1) {
          if (trimValue.length) {
            const linkElement = createElementFromHTML(
              `<span class="section"><a href="#">${htmlEscape(value)}</a></span>`,
            );
            const dividerElement = createElementFromHTML(
              `<div class="breadcrumb-divider">/</div>`,
            );
            links.push(linkElement);
            dividers.push(dividerElement);
            filenameInput.before(linkElement);
            filenameInput.before(dividerElement);
          }
        } else {
          filenameInput.value = value;
        }
        this.setSelectionRange(0, 0);
        containSpace = containSpace || (trimValue !== value && trimValue !== '');
      }
    }
    containSpace = containSpace || Array.from(links).some((link) => {
      const value = link.querySelector('a').textContent;
      return value.trim() !== value;
    });
    containSpace = containSpace || parts[parts.length - 1].trim() !== parts[parts.length - 1];
    if (containSpace) {
      if (!warningDiv) {
        warningDiv = document.createElement('div');
        warningDiv.classList.add('ui', 'warning', 'message', 'flash-message', 'flash-warning', 'space-related');
        warningDiv.innerHTML = '<p>File path contains leading or trailing whitespace.</p>';
        // Add display 'block' because display is set to 'none' in formantic\build\semantic.css
        warningDiv.style.display = 'block';
        const inputContainer = document.querySelector('.repo-editor-header');
        inputContainer.insertAdjacentElement('beforebegin', warningDiv);
      }
      showElem(warningDiv);
    } else if (warningDiv) {
      hideElem(warningDiv);
    }
    joinTreePath();
  });
  filenameInput.addEventListener('keydown', function (e) {
    const sections = queryElems(document, '.breadcrumb span.section');
    const dividers = queryElems(document, '.breadcrumb .breadcrumb-divider');
    // Jump back to last directory once the filename is empty
    if (e.code === 'Backspace' && filenameInput.selectionStart === 0 && sections.length > 0) {
      e.preventDefault();
      const lastSection = sections[sections.length - 1];
      const lastDivider = dividers.length ? dividers[dividers.length - 1] : null;
      const value = lastSection.querySelector('a').textContent;
      filenameInput.value = value + filenameInput.value;
      this.setSelectionRange(value.length, value.length);
      lastDivider?.remove();
      lastSection.remove();
      joinTreePath();
    }
  });

  const $form = $('.repository.editor .edit.form');
  initEditPreviewTab($form);

  (async () => {
    const editor = await createCodeEditor(editArea, filenameInput);

    // Using events from https://github.com/codedance/jquery.AreYouSure#advanced-usage
    // to enable or disable the commit button
    const commitButton = document.querySelector<HTMLButtonElement>('#commit-button');
    const $editForm = $('.ui.edit.form');
    const dirtyFileClass = 'dirty-file';

    // Disabling the button at the start
    if ($('input[name="page_has_posted"]').val() !== 'true') {
      commitButton.disabled = true;
    }

    // Registering a custom listener for the file path and the file content
    $editForm.areYouSure({
      silent: true,
      dirtyClass: dirtyFileClass,
      fieldSelector: ':input:not(.commit-form-wrapper :input)',
      change($form) {
        const dirty = $form[0]?.classList.contains(dirtyFileClass);
        commitButton.disabled = !dirty;
      },
    });

    // Update the editor from query params, if available,
    // only after the dirtyFileClass initialization
    const params = new URLSearchParams(window.location.search);
    const value = params.get('value');
    if (value) {
      editor.setValue(value);
    }

    commitButton?.addEventListener('click', (e) => {
      // A modal which asks if an empty file should be committed
      if (!editArea.value) {
        $('#edit-empty-content-modal').modal({
          onApprove() {
            $('.edit.form').trigger('submit');
          },
        }).modal('show');
        e.preventDefault();
      }
    });
  })();
}

export function renderPreviewPanelContent($previewPanel, data) {
  $previewPanel.html(data);
  initMarkupContent();

  const $refIssues = $previewPanel.find('p .ref-issue');
  attachRefIssueContextPopup($refIssues);
}
