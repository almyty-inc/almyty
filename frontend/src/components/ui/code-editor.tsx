import React from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { githubLight } from '@uiw/codemirror-theme-github'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  language?: 'javascript' | 'json' | 'text'
  height?: string
  placeholder?: string
  readOnly?: boolean
  className?: string
}

export function CodeEditor({
  value,
  onChange,
  language = 'javascript',
  height = '120px',
  placeholder,
  readOnly = false,
  className = '',
}: CodeEditorProps) {
  const isDark = document.documentElement.classList.contains('dark')

  const extensions = []
  if (language === 'javascript') extensions.push(javascript())
  if (language === 'json') extensions.push(json())

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height={height}
      theme={isDark ? oneDark : githubLight}
      extensions={extensions}
      readOnly={readOnly}
      placeholder={placeholder}
      className={`border rounded-md overflow-hidden ${className}`}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
        tabSize: 2,
      }}
    />
  )
}
